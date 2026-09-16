import type { ChatFn, ChatMessage, ChatRequest } from '../groq/types';
import { GroqRateLimitError, GroqToolUseError } from '../groq/types';
import { ALL_TOOLS, runTool, toolRegistry, toolSpecs } from '../tools';
import type { AnyTool, ToolContext } from '../tools/types';
import { citationsFromResult, dedupeCitations } from './citations';
import type { NoticeSink } from './notices';
import { parseModelStep, recoverFromFailedGeneration } from './parse';
import {
  buildAnswerOnlySystemPrompt,
  buildForcedAnswerPrompt,
  buildRecoveryPrompt,
  buildSystemPrompt,
} from './prompt';
import {
  addUsage,
  emptyUsage,
  TRACE_FORMAT_VERSION,
  type Citation,
  type RunStatus,
  type RunTrace,
  type TraceEvent,
} from './types';

export interface AgentOptions {
  readonly goal: string;
  readonly model: string;
  readonly chat: ChatFn;
  readonly tools?: readonly AnyTool[];
  /** Hard ceiling on tool-calling rounds. The loop cannot exceed this. */
  readonly maxSteps?: number;
  readonly maxToolCallsPerStep?: number;
  readonly maxTokensPerCall?: number;
  readonly temperature?: number;
  readonly toolContext?: ToolContext;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly runId?: string;
  readonly role?: string;
  /**
   * When the step budget runs out, spend one more model call with tools
   * disabled to get a real answer instead of stopping mid-thought.
   */
  readonly forceFinalAnswer?: boolean;
  /** Notices raised inside a model call, drained at each step boundary. */
  readonly notices?: NoticeSink;
}

export const DEFAULT_MAX_STEPS = 6;
const MAX_TOOL_CALLS_PER_STEP = 4;
/** Cap on the observation text fed back per tool call. */
const MAX_OBSERVATION_CHARS = 6_000;

function truncate(text: string, max = MAX_OBSERVATION_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[observation truncated]`;
}

/** Stable key for "the model already made exactly this call". */
function callKey(tool: string, args: unknown): string {
  try {
    return `${tool}:${JSON.stringify(args, Object.keys((args ?? {}) as object).sort())}`;
  } catch {
    return `${tool}:${String(args)}`;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted');
}

/**
 * The agent loop.
 *
 * An async generator, so the route handler can stream each event the instant
 * it happens and the swarm scheduler can interleave many of these without any
 * of them owning the output channel. The return value is the complete,
 * replayable trace.
 */
export async function* runAgent(
  options: AgentOptions,
): AsyncGenerator<TraceEvent, RunTrace, void> {
  const now = options.now ?? Date.now;
  const tools = options.tools ?? ALL_TOOLS;
  const registry = toolRegistry(tools);
  const specs = toolSpecs(tools);
  const toolNames = tools.map((tool) => tool.name);
  const maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  const maxToolCallsPerStep = options.maxToolCallsPerStep ?? MAX_TOOL_CALLS_PER_STEP;
  const runId = options.runId ?? `run_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = now();

  const events: TraceEvent[] = [];
  const record = (event: TraceEvent): TraceEvent => {
    events.push(event);
    return event;
  };

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        maxSteps,
        tools,
        ...(options.role ? { role: options.role } : {}),
      }),
    },
    { role: 'user', content: options.goal },
  ];

  let usage = emptyUsage();
  let modelCalls = 0;
  let toolCalls = 0;
  let step = 0;
  let answer: string | null = null;
  let status: RunStatus = 'failed';
  let errorMessage: string | undefined;
  let rateLimitRetryAfterMs: number | undefined;
  const citations: Citation[] = [];
  const toolsUsed = new Set<string>();
  /** Every distinct tool call and what it returned, for the forced answer. */
  const evidence: string[] = [];
  const seenCalls = new Map<string, string>();

  const finish = (): RunTrace => {
    const finishedAt = now();
    const finished: TraceEvent = {
      type: 'run_finished',
      at: finishedAt,
      runId,
      status,
      steps: step,
      usage,
      wallMs: finishedAt - startedAt,
      modelCalls,
      toolCalls,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
    events.push(finished);
    return {
      version: TRACE_FORMAT_VERSION,
      runId,
      goal: options.goal,
      model: options.model,
      status,
      startedAt,
      finishedAt,
      wallMs: finishedAt - startedAt,
      steps: step,
      usage,
      answer,
      citations: dedupeCitations(citations),
      events,
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(rateLimitRetryAfterMs === undefined ? {} : { rateLimitRetryAfterMs }),
    };
  };

  /**
   * Terminal events must be YIELDED, not merely recorded. A streaming client
   * sees only what the generator yields; a generator's return value never
   * reaches `for await`. Recording `run_finished` without yielding it meant the
   * UI could never learn a run had ended.
   */
  const finishAndYield = async function* (): AsyncGenerator<TraceEvent, RunTrace, void> {
    const trace = finish();
    const terminal = trace.events[trace.events.length - 1];
    if (terminal) yield terminal;
    return trace;
  };

  yield record({
    type: 'run_started',
    at: startedAt,
    runId,
    goal: options.goal,
    model: options.model,
    maxSteps,
    tools: toolNames,
  });

  const callModel = async () => {
    const request: ChatRequest = {
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokensPerCall ?? 1024,
      tools: specs,
      toolChoice: 'auto' as const,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const response = await options.chat(request);
    modelCalls += 1;
    usage = addUsage(usage, response.usage);
    return response;
  };

  /**
   * Handle a provider-rejected tool call. Either run what the model meant, or
   * tell it the exact names it may use. Either way the conversation stays
   * valid: the rejected generation never became an assistant message, so
   * nothing is appended that references a tool_call id the provider refused.
   */
  const recoverRejectedCall = async function* (
    error: GroqToolUseError,
  ): AsyncGenerator<TraceEvent, void, void> {
    const recovered = recoverFromFailedGeneration(error.failedGeneration, toolNames);
    if (!recovered) {
      messages.push({
        role: 'user',
        content:
          'Your last tool call was rejected because the tool name was not valid. ' +
          `Use one of these names exactly: ${toolNames.join(', ')}. ` +
          'Call a tool with an exact name, or write the final answer as plain text.',
      });
      return;
    }

    yield record({
      type: 'notice',
      at: now(),
      step,
      level: 'info',
      code: 'tool-name-recovered',
      message: `Recovered "${recovered.rawName}" as "${recovered.name}" and ran it.`,
    });

    const callId = `recovered_${step}_${toolCalls}`;
    yield record({
      type: 'tool_call',
      at: now(),
      step,
      callId,
      tool: recovered.name,
      args: recovered.args,
    });

    const outcome = await runTool(registry.get(recovered.name), recovered.name, recovered.args, {
      ...options.toolContext,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    toolCalls += 1;
    toolsUsed.add(recovered.name);

    const key = callKey(recovered.name, recovered.args);
    if (outcome.ok) {
      seenCalls.set(key, outcome.observation);
      evidence.push(
        `[step ${step}] ${recovered.name}(${JSON.stringify(recovered.args)})\n${truncate(outcome.observation, 2_500)}`,
      );
      citations.push(...citationsFromResult(outcome.result, recovered.name, step));
    } else {
      seenCalls.set(key, `ERROR (${outcome.error.kind}): ${outcome.error.message}`);
    }

    yield record({
      type: 'tool_result',
      at: now(),
      step,
      callId,
      tool: recovered.name,
      ok: outcome.ok,
      durationMs: outcome.durationMs,
      observation: outcome.ok ? outcome.observation : outcome.error.message,
      ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
    });

    // Delivered as a user message, not a tool message: there is no assistant
    // tool_call for it to answer, because the provider rejected that generation.
    messages.push({
      role: 'user',
      content:
        `Your tool name was invalid, so it was corrected to "${recovered.name}" and run for you. ` +
        `Result:\n\n${truncate(outcome.ok ? outcome.observation : outcome.error.message)}\n\n` +
        `Use exact tool names from this list: ${toolNames.join(', ')}.`,
    });
  };

  try {
    while (step < maxSteps) {
      if (options.signal?.aborted) {
        status = 'cancelled';
        errorMessage = 'The run was cancelled.';
        return yield* finishAndYield();
      }

      step += 1;
      yield record({ type: 'step_started', at: now(), step });

      let response;
      try {
        response = await callModel();
      } catch (error) {
        if (!(error instanceof GroqToolUseError)) throw error;
        // The provider refused the model's own tool call. That is bad model
        // output, not a broken request, so recover instead of failing the run.
        yield record({
          type: 'notice',
          at: now(),
          step,
          level: 'warn',
          code: 'provider-rejected-tool-call',
          message: error.message,
        });
        yield* recoverRejectedCall(error);
        continue;
      }

      for (const pending of options.notices?.drain() ?? []) {
        yield record({
          type: 'notice',
          at: now(),
          step,
          level: pending.level,
          code: pending.code,
          message: pending.message,
        });
      }

      yield record({
        type: 'model_call',
        at: now(),
        step,
        model: response.model,
        latencyMs: response.latencyMs,
        usage: response.usage,
        finishReason: response.finishReason,
        toolCallCount: response.toolCalls.length,
      });

      if (response.reasoning && response.reasoning.trim().length > 0) {
        yield record({
          type: 'thought',
          at: now(),
          step,
          text: response.reasoning.trim(),
          source: 'reasoning',
        });
      }

      const parsed = parseModelStep(response, toolNames);

      for (const problem of parsed.problems) {
        yield record({
          type: 'notice',
          at: now(),
          step,
          level: problem.code === 'repaired-json' ? 'info' : 'warn',
          code: problem.code,
          message: problem.message,
        });
      }

      if (parsed.finalAnswer !== null) {
        answer = parsed.finalAnswer;
        status = 'completed';
        yield record({
          type: 'final_answer',
          at: now(),
          step,
          text: answer,
          citations: dedupeCitations(citations),
          toolsUsed: [...toolsUsed],
        });
        return yield* finishAndYield();
      }

      if (parsed.toolCalls.length === 0) {
        // Nothing usable came back. Tell the model exactly what went wrong and
        // spend another step rather than failing the whole run.
        messages.push({ role: 'assistant', content: response.content || '(empty)' });
        messages.push({
          role: 'user',
          content: buildRecoveryPrompt(parsed.problems.map((problem) => problem.message)),
        });
        continue;
      }

      const accepted = parsed.toolCalls.slice(0, maxToolCallsPerStep);
      if (accepted.length < parsed.toolCalls.length) {
        yield record({
          type: 'notice',
          at: now(),
          step,
          level: 'warn',
          code: 'tool-calls-capped',
          message: `The model asked for ${parsed.toolCalls.length} tool calls in one step; only the first ${accepted.length} ran.`,
        });
      }

      messages.push({
        role: 'assistant',
        content: response.content ?? '',
        tool_calls: accepted.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      });

      for (const call of accepted) {
        yield record({
          type: 'tool_call',
          at: now(),
          step,
          callId: call.id,
          tool: call.name,
          args: call.args,
        });

        const key = callKey(call.name, call.args);
        const previous = seenCalls.get(key);
        if (previous !== undefined) {
          // A model that gets a disappointing result will often re-issue the
          // identical call until the step budget is gone. Hand back what it
          // already received and say so, instead of paying for the same work.
          yield record({
            type: 'notice',
            at: now(),
            step,
            level: 'warn',
            code: 'duplicate-tool-call',
            message: `The model repeated an identical "${call.name}" call; the previous result was returned without re-running the tool.`,
          });
          yield record({
            type: 'tool_result',
            at: now(),
            step,
            callId: call.id,
            tool: call.name,
            ok: true,
            durationMs: 0,
            observation: previous,
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content:
              'You already made this exact call. Here is the result you were given before. ' +
              'Do not call it again with the same arguments; either try different arguments, ' +
              `a different tool, or write the final answer.\n\n${truncate(previous, 2_000)}`,
          });
          continue;
        }

        const outcome = await runTool(registry.get(call.name), call.name, call.args, {
          ...options.toolContext,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        toolCalls += 1;
        toolsUsed.add(call.name);

        if (outcome.ok) {
          seenCalls.set(key, outcome.observation);
          evidence.push(
            `[step ${step}] ${call.name}(${JSON.stringify(call.args)})\n${truncate(outcome.observation, 2_500)}`,
          );
          citations.push(...citationsFromResult(outcome.result, call.name, step));
          yield record({
            type: 'tool_result',
            at: now(),
            step,
            callId: call.id,
            tool: call.name,
            ok: true,
            durationMs: outcome.durationMs,
            observation: outcome.observation,
            result: outcome.result,
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: truncate(outcome.observation),
          });
        } else {
          seenCalls.set(key, `ERROR (${outcome.error.kind}): ${outcome.error.message}`);
          yield record({
            type: 'tool_result',
            at: now(),
            step,
            callId: call.id,
            tool: call.name,
            ok: false,
            durationMs: outcome.durationMs,
            observation: outcome.error.message,
            error: outcome.error,
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: `ERROR (${outcome.error.kind}): ${outcome.error.message}`,
          });
        }
      }
    }

    // Step budget exhausted. Ask for the answer on a clean conversation that
    // carries the evidence as text and no tool-calling machinery at all.
    status = 'budget-exhausted';
    if (options.forceFinalAnswer === false) {
      errorMessage = `The step budget of ${maxSteps} ran out.`;
      return yield* finishAndYield();
    }

    try {
      const response = await options.chat({
        model: options.model,
        messages: [
          { role: 'system', content: buildAnswerOnlySystemPrompt() },
          { role: 'user', content: buildForcedAnswerPrompt(options.goal, maxSteps, evidence) },
        ],
        temperature: options.temperature ?? 0.2,
        maxTokens: options.maxTokensPerCall ?? 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      modelCalls += 1;
      usage = addUsage(usage, response.usage);
      yield record({
        type: 'model_call',
        at: now(),
        step,
        model: response.model,
        latencyMs: response.latencyMs,
        usage: response.usage,
        finishReason: response.finishReason,
        toolCallCount: 0,
      });
      if (response.content.trim().length > 0) {
        answer = response.content.trim();
        yield record({
          type: 'final_answer',
          at: now(),
          step,
          text: answer,
          citations: dedupeCitations(citations),
          toolsUsed: [...toolsUsed],
        });
      } else {
        errorMessage = 'The step budget ran out and the model produced no final answer.';
      }
    } catch (error) {
      if (isAbort(error) || options.signal?.aborted) throw error;
      // The forced answer is a best effort on top of work already done. Losing
      // it must not relabel a run that gathered real evidence as a failure.
      errorMessage =
        'The step budget ran out and the final answer call failed: ' +
        (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      yield record({
        type: 'notice',
        at: now(),
        step,
        level: 'warn',
        code: 'final-answer-call-failed',
        message: errorMessage,
      });
    }
    return yield* finishAndYield();
  } catch (error) {
    if (isAbort(error) || options.signal?.aborted) {
      status = 'cancelled';
      errorMessage = 'The run was cancelled.';
    } else if (error instanceof GroqRateLimitError) {
      status = 'rate-limited';
      errorMessage = error.message;
      rateLimitRetryAfterMs = error.retryAfterMs;
    } else {
      status = 'failed';
      errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    yield record({
      type: 'notice',
      at: now(),
      step,
      level: 'warn',
      code: status,
      message: errorMessage,
    });
    return yield* finishAndYield();
  }
}

/** Drain a run to completion. Used by the swarm and by tests. */
export async function collectRun(
  options: AgentOptions,
  onEvent?: (event: TraceEvent) => void,
): Promise<RunTrace> {
  const iterator = runAgent(options);
  for (;;) {
    const next = await iterator.next();
    if (next.done) return next.value;
    onEvent?.(next.value);
  }
}
