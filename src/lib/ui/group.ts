import type { RunStatus, TraceEvent } from '../agent/types';
import type { TokenUsage } from '../groq/types';

/** One step of the loop, assembled from the flat event stream. */
export interface StepGroup {
  readonly step: number;
  readonly startedAt: number;
  thought: string | null;
  modelLatencyMs: number | null;
  usage: TokenUsage | null;
  finishReason: string | null;
  readonly calls: Array<{
    readonly callId: string;
    readonly tool: string;
    args: unknown;
    result: Extract<TraceEvent, { type: 'tool_result' }> | null;
  }>;
  readonly notices: Array<Extract<TraceEvent, { type: 'notice' }>>;
}

export interface GroupedTrace {
  readonly header: Extract<TraceEvent, { type: 'run_started' }> | null;
  readonly steps: StepGroup[];
  readonly finalAnswer: Extract<TraceEvent, { type: 'final_answer' }> | null;
  readonly finished: Extract<TraceEvent, { type: 'run_finished' }> | null;
  readonly status: RunStatus | 'running';
  readonly usage: TokenUsage;
}

/**
 * Fold the event stream into steps for rendering.
 *
 * Deliberately a pure function over the same events that get serialised: a
 * replayed trace and a live one go through this identical path, so a replay
 * cannot show something the live run did not.
 */
export function groupTrace(events: readonly TraceEvent[]): GroupedTrace {
  let header: GroupedTrace['header'] = null;
  let finalAnswer: GroupedTrace['finalAnswer'] = null;
  let finished: GroupedTrace['finished'] = null;
  const byStep = new Map<number, StepGroup>();
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  const ensure = (step: number, at: number): StepGroup => {
    const existing = byStep.get(step);
    if (existing) return existing;
    const created: StepGroup = {
      step,
      startedAt: at,
      thought: null,
      modelLatencyMs: null,
      usage: null,
      finishReason: null,
      calls: [],
      notices: [],
    };
    byStep.set(step, created);
    return created;
  };

  for (const event of events) {
    switch (event.type) {
      case 'run_started':
        header = event;
        break;
      case 'step_started':
        ensure(event.step, event.at);
        break;
      case 'thought': {
        const group = ensure(event.step, event.at);
        group.thought = group.thought ? `${group.thought}\n\n${event.text}` : event.text;
        break;
      }
      case 'model_call': {
        const group = ensure(event.step, event.at);
        group.modelLatencyMs = (group.modelLatencyMs ?? 0) + event.latencyMs;
        group.usage = group.usage
          ? {
              promptTokens: group.usage.promptTokens + event.usage.promptTokens,
              completionTokens: group.usage.completionTokens + event.usage.completionTokens,
              totalTokens: group.usage.totalTokens + event.usage.totalTokens,
            }
          : event.usage;
        group.finishReason = event.finishReason;
        usage = {
          promptTokens: usage.promptTokens + event.usage.promptTokens,
          completionTokens: usage.completionTokens + event.usage.completionTokens,
          totalTokens: usage.totalTokens + event.usage.totalTokens,
        };
        break;
      }
      case 'tool_call': {
        const group = ensure(event.step, event.at);
        group.calls.push({ callId: event.callId, tool: event.tool, args: event.args, result: null });
        break;
      }
      case 'tool_result': {
        const group = ensure(event.step, event.at);
        const call = group.calls.find((candidate) => candidate.callId === event.callId);
        if (call) call.result = event;
        else group.calls.push({ callId: event.callId, tool: event.tool, args: null, result: event });
        break;
      }
      case 'notice': {
        const group = ensure(Math.max(1, event.step), event.at);
        group.notices.push(event);
        break;
      }
      case 'final_answer':
        finalAnswer = event;
        break;
      case 'run_finished':
        finished = event;
        break;
      default:
        break;
    }
  }

  return {
    header,
    steps: [...byStep.values()].sort((a, b) => a.step - b.step),
    finalAnswer,
    finished,
    status: finished?.status ?? 'running',
    usage: finished?.usage ?? usage,
  };
}

export const STATUS_TONE: Record<RunStatus | 'running', 'ok' | 'warn' | 'danger' | 'info' | 'neutral'> = {
  completed: 'ok',
  'budget-exhausted': 'warn',
  failed: 'danger',
  cancelled: 'neutral',
  'rate-limited': 'warn',
  running: 'info',
};
