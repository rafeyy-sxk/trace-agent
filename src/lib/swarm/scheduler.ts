import { collectRun } from '../agent/loop';
import { addUsage, emptyUsage, type Citation, type TraceEvent } from '../agent/types';
import { dedupeCitations } from '../agent/citations';
import { GroqRateLimitError, type ChatFn, type ChatRequest } from '../groq/types';
import { ALL_TOOLS, toolSpecs } from '../tools';
import type { AnyTool, ToolContext } from '../tools/types';
import { estimateCallTokens, TokenBudget } from './budget';
import { AbortedError, EventQueue, realSleep, Semaphore, type Sleep } from './concurrency';
import { BudgetGate } from './gate';
import { mergeAnswers } from './merge';
import {
  NON_TERMINAL_STATES,
  SWARM_FORMAT_VERSION,
  type AgentState,
  type AgentSummary,
  type SubGoal,
  type SwarmEvent,
  type SwarmReport,
} from './types';

export interface SwarmOptions {
  readonly goal: string;
  readonly subGoals: readonly SubGoal[];
  readonly model: string;
  /** Must NOT retry 429 internally — the scheduler owns retry policy. */
  readonly chat: ChatFn;
  readonly budget: TokenBudget;
  readonly concurrency: number;
  readonly maxAttempts?: number;
  readonly maxStepsPerAgent?: number;
  readonly maxTokensPerCall?: number;
  readonly tools?: readonly AnyTool[];
  readonly toolContext?: ToolContext;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: Sleep;
  /** Spend one extra model call merging the answers. Off => deterministic merge. */
  readonly synthesize?: boolean;
  /** Emit a budget snapshot at most this often. */
  readonly budgetSampleMs?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_STEPS = 3;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5_000;
const DEFAULT_MAX_TOKENS_PER_CALL = 700;

interface AgentRecord {
  readonly subGoal: SubGoal;
  state: AgentState;
  attempts: number;
  steps: number;
  usage: ReturnType<typeof emptyUsage>;
  wallMs: number;
  answer: string | null;
  citations: Citation[];
  error: string | null;
  status: AgentSummary['status'];
}

function toSummary(record: AgentRecord): AgentSummary {
  return {
    agentId: record.subGoal.id,
    index: record.subGoal.index,
    title: record.subGoal.title,
    goal: record.subGoal.goal,
    state: record.state,
    status: record.status,
    attempts: record.attempts,
    steps: record.steps,
    usage: record.usage,
    wallMs: record.wallMs,
    answer: record.answer,
    citations: record.citations,
    error: record.error,
  };
}

/**
 * Run many agents against one shared token ceiling.
 *
 * Three independent limits, and all three are enforced rather than hoped for:
 *   - a concurrency cap (`Semaphore`), so N agent loops are live at most,
 *   - a rolling token ceiling (`TokenBudget` + `BudgetGate`), so model calls
 *     are held at a gate instead of being sent and rejected,
 *   - a per-agent attempt cap, so an agent that keeps hitting 429 is reported
 *     failed rather than retrying forever or vanishing.
 */
export async function* runSwarm(
  options: SwarmOptions,
): AsyncGenerator<SwarmEvent, SwarmReport, void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const tools = options.tools ?? ALL_TOOLS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const maxSteps = Math.max(1, options.maxStepsPerAgent ?? DEFAULT_MAX_STEPS);
  const maxTokensPerCall = options.maxTokensPerCall ?? DEFAULT_MAX_TOKENS_PER_CALL;
  const budgetSampleMs = options.budgetSampleMs ?? 400;
  const startedAt = now();
  const swarmId = `swarm_${startedAt.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  const budget = options.budget;
  const gate = new BudgetGate(budget, sleep, now);
  const semaphore = new Semaphore(Math.max(1, options.concurrency));
  const queue = new EventQueue<SwarmEvent>();
  const toolSpecTokens = Math.ceil(JSON.stringify(toolSpecs(tools)).length / 3.2);

  const records = new Map<string, AgentRecord>();
  for (const subGoal of options.subGoals) {
    records.set(subGoal.id, {
      subGoal,
      state: 'queued',
      attempts: 0,
      steps: 0,
      usage: emptyUsage(),
      wallMs: 0,
      answer: null,
      citations: [],
      error: null,
      status: null,
    });
  }

  let totalUsage = emptyUsage();
  let modelCalls = 0;
  let toolCallCount = 0;
  let rateLimitHits = 0;
  let retriesAbsorbed = 0;
  let lastBudgetSample = 0;

  const emit = (event: SwarmEvent): void => queue.push(event);

  const setState = (record: AgentRecord, state: AgentState, detail?: string): void => {
    record.state = state;
    emit({
      type: 'agent_state',
      at: now(),
      agentId: record.subGoal.id,
      state,
      attempt: record.attempts,
      ...(detail ? { detail } : {}),
    });
  };

  const sampleBudget = (force = false): void => {
    const at = now();
    if (!force && at - lastBudgetSample < budgetSampleMs) return;
    lastBudgetSample = at;
    let running = 0;
    let waitingOnBudget = 0;
    let queued = 0;
    for (const record of records.values()) {
      if (record.state === 'running') running += 1;
      else if (record.state === 'waiting-on-budget') waitingOnBudget += 1;
      else if (record.state === 'queued' || record.state === 'retrying') queued += 1;
    }
    emit({
      type: 'budget',
      at,
      spentInWindow: budget.spentInWindow(),
      ceiling: budget.limit,
      running,
      waitingOnBudget,
      queued,
      cooldownMs: budget.cooldownRemaining(),
    });
  };

  /**
   * Wrap the raw chat function for one agent: reserve budget before the call,
   * reconcile against real usage after it, and translate a 429 into a signal
   * the scheduler can act on.
   */
  const gatedChatFor = (record: AgentRecord): ChatFn => {
    return async (request: ChatRequest) => {
      const estimate = estimateCallTokens(
        request.messages,
        request.maxTokens ?? maxTokensPerCall,
        request.tools && request.tools.length > 0 ? toolSpecTokens : 0,
      );
      setState(record, 'waiting-on-budget');
      sampleBudget();
      const reservation = await gate.acquire(estimate, options.signal);
      setState(record, 'running');
      try {
        const response = await options.chat(request);
        modelCalls += 1;
        budget.settle(reservation, response.usage.totalTokens);
        if (response.tokenLimitPerMinute !== null) budget.calibrate(response.tokenLimitPerMinute);
        sampleBudget();
        return response;
      } catch (error) {
        if (error instanceof GroqRateLimitError) {
          // The tokens were spent even though the call failed: the provider
          // counted them. Keep the estimate in the window and hold everyone.
          budget.settle(reservation, estimate);
          budget.penalise(error.retryAfterMs);
        } else {
          budget.release(reservation);
        }
        sampleBudget(true);
        throw error;
      }
    };
  };

  const runOneAgent = async (record: AgentRecord): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) {
        setState(record, 'cancelled');
        record.error = 'cancelled before dispatch';
        return;
      }
      record.attempts += 1;
      const attemptStartedAt = now();
      let release: (() => void) | null = null;
      try {
        release = await semaphore.acquire(options.signal);
        setState(record, 'running');

        const trace = await collectRun(
          {
            goal: record.subGoal.goal,
            model: options.model,
            chat: gatedChatFor(record),
            tools,
            maxSteps,
            maxTokensPerCall,
            forceFinalAnswer: true,
            role:
              'You are one of many agents each researching a different part of a larger question. ' +
              'Answer only your own sub-goal. Be concise and lead with the finding.',
            ...(options.toolContext ? { toolContext: options.toolContext } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.now ? { now: options.now } : {}),
            runId: `${record.subGoal.id}_a${record.attempts}`,
          },
          (event: TraceEvent) => {
            if (event.type === 'tool_result') toolCallCount += 1;
            emit({ type: 'agent_event', at: now(), agentId: record.subGoal.id, event });
          },
        );

        record.usage = addUsage(record.usage, trace.usage);
        totalUsage = addUsage(totalUsage, trace.usage);
        record.steps = trace.steps;
        record.wallMs += now() - attemptStartedAt;
        record.citations = dedupeCitations([...record.citations, ...trace.citations]);
        record.status = trace.status;

        if (trace.status === 'cancelled') {
          setState(record, 'cancelled');
          record.error = 'cancelled mid-run';
          return;
        }

        if (trace.status === 'rate-limited') {
          // The loop absorbs a 429 into a trace status rather than throwing, so
          // re-raise it here. Otherwise the scheduler would apply generic
          // backoff and silently ignore the provider's own retry-after.
          throw new GroqRateLimitError(
            'the agent was rate limited',
            trace.rateLimitRetryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS,
          );
        }

        if (trace.answer && trace.answer.trim().length > 0) {
          record.answer = trace.answer.trim();
          setState(record, 'done');
          if (record.attempts > 1) retriesAbsorbed += record.attempts - 1;
          return;
        }

        // The loop returned without an answer. Treat it like any other failure
        // so the attempt cap applies rather than silently dropping the agent.
        throw new Error(trace.error ?? 'the agent produced no answer');
      } catch (error) {
        record.wallMs += now() - attemptStartedAt;

        if (error instanceof AbortedError || options.signal?.aborted) {
          setState(record, 'cancelled');
          record.error = 'cancelled';
          return;
        }

        const isRateLimit = error instanceof GroqRateLimitError;
        if (isRateLimit) {
          rateLimitHits += 1;
          const retryAfterMs = error.retryAfterMs;
          const willRequeue = record.attempts < maxAttempts;
          emit({
            type: 'rate_limited',
            at: now(),
            agentId: record.subGoal.id,
            attempt: record.attempts,
            retryAfterMs,
            requeued: willRequeue,
          });
          if (willRequeue) {
            setState(record, 'retrying', `rate limited, retrying in ${retryAfterMs}ms`);
            release?.();
            release = null;
            try {
              await sleep(retryAfterMs, options.signal);
            } catch {
              setState(record, 'cancelled');
              record.error = 'cancelled while waiting out a rate limit';
              return;
            }
            continue;
          }
        }

        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        if (record.attempts < maxAttempts && !isRateLimit) {
          setState(record, 'retrying', message);
          release?.();
          release = null;
          try {
            await sleep(Math.min(4_000, 250 * 2 ** record.attempts), options.signal);
          } catch {
            setState(record, 'cancelled');
            record.error = 'cancelled while backing off';
            return;
          }
          continue;
        }

        record.error = message;
        record.status = record.status ?? 'failed';
        setState(record, 'failed', message);
        return;
      } finally {
        release?.();
      }
    }
  };

  emit({
    type: 'swarm_started',
    at: startedAt,
    swarmId,
    goal: options.goal,
    model: options.model,
    agentCount: options.subGoals.length,
    concurrency: options.concurrency,
    tokenCeiling: budget.limit,
  });
  emit({ type: 'plan_ready', at: now(), subGoals: options.subGoals });
  sampleBudget(true);

  const allAgents = Promise.all([...records.values()].map((record) => runOneAgent(record)))
    .then(async () => {
      const finished = [...records.values()];
      for (const record of finished) {
        emit({ type: 'agent_finished', at: now(), summary: toSummary(record) });
      }
      const merged = await mergeAnswers({
        goal: options.goal,
        records: finished.map((record) => ({
          id: record.subGoal.id,
          title: record.subGoal.title,
          answer: record.answer,
        })),
        model: options.model,
        chat: options.chat,
        gate,
        budget,
        toolSpecTokens,
        synthesize: options.synthesize !== false && !options.signal?.aborted,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (merged) {
        totalUsage = addUsage(totalUsage, merged.usage);
        if (merged.synthesized) modelCalls += 1;
        emit({
          type: 'merged_answer',
          at: now(),
          text: merged.text,
          contributingAgents: merged.contributingAgents,
          synthesized: merged.synthesized,
        });
      }
    })
    .catch((error: unknown) => {
      emit({
        type: 'agent_state',
        at: now(),
        agentId: 'scheduler',
        state: 'failed',
        attempt: 0,
        detail: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      gate.drain();
      semaphore.drain();
      queue.close();
    });

  let mergedAnswer: string | null = null;
  for await (const event of queue.stream()) {
    if (event.type === 'merged_answer') mergedAnswer = event.text;
    yield event;
  }
  await allAgents;

  // Nothing may end in a state it could still leave.
  const finishedAt = now();
  for (const record of records.values()) {
    if (NON_TERMINAL_STATES.includes(record.state)) {
      record.state = options.signal?.aborted ? 'cancelled' : 'failed';
      record.error = record.error ?? 'the run ended while this agent was still in flight';
    }
  }

  const agents = [...records.values()].map(toSummary);
  const report: SwarmReport = {
    version: SWARM_FORMAT_VERSION,
    swarmId,
    goal: options.goal,
    model: options.model,
    startedAt,
    finishedAt,
    ledger: {
      dispatched: agents.filter((agent) => agent.attempts > 0).length,
      completed: agents.filter((agent) => agent.state === 'done').length,
      failed: agents.filter((agent) => agent.state === 'failed').length,
      cancelled: agents.filter((agent) => agent.state === 'cancelled').length,
      retriesAbsorbed,
      rateLimitHits,
      maxConcurrencyReached: semaphore.maxObserved,
      configuredConcurrency: options.concurrency,
      wallMs: finishedAt - startedAt,
      usage: totalUsage,
      modelCalls,
      toolCalls: toolCallCount,
      peakTokensInWindow: budget.peak,
      tokenCeiling: budget.limit,
      declaredTokenLimit: budget.declaredLimit,
      budgetWaitMs: gate.waitMs,
    },
    agents,
    mergedAnswer,
    citations: dedupeCitations(agents.flatMap((agent) => agent.citations)),
  };

  yield { type: 'swarm_finished', at: finishedAt, report };
  return report;
}
