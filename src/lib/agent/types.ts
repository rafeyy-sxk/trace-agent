import type { TokenUsage } from '../groq/types';
import type { ToolFailure } from '../tools/types';

export const TRACE_FORMAT_VERSION = 1;

export type RunStatus =
  | 'completed'
  | 'budget-exhausted'
  | 'failed'
  | 'cancelled'
  | 'rate-limited';

export interface Citation {
  readonly title: string;
  readonly url: string;
  readonly tool: string;
  readonly step: number;
}

/**
 * Everything the agent does, as a stream of facts.
 *
 * Every event carries `at` (epoch ms) and, where it belongs to a step, the
 * step index. The UI renders this union directly and the replay file is
 * literally an array of these — there is no second, prettier representation
 * that could disagree with what actually happened.
 */
export type TraceEvent =
  | {
      readonly type: 'run_started';
      readonly at: number;
      readonly runId: string;
      readonly goal: string;
      readonly model: string;
      readonly maxSteps: number;
      readonly tools: readonly string[];
    }
  | { readonly type: 'step_started'; readonly at: number; readonly step: number }
  | {
      readonly type: 'thought';
      readonly at: number;
      readonly step: number;
      readonly text: string;
      /** `reasoning` is the model's own field; `content` is its visible message. */
      readonly source: 'reasoning' | 'content';
    }
  | {
      readonly type: 'model_call';
      readonly at: number;
      readonly step: number;
      readonly model: string;
      readonly latencyMs: number;
      readonly usage: TokenUsage;
      readonly finishReason: string;
      readonly toolCallCount: number;
    }
  | {
      readonly type: 'tool_call';
      readonly at: number;
      readonly step: number;
      readonly callId: string;
      readonly tool: string;
      readonly args: unknown;
    }
  | {
      readonly type: 'tool_result';
      readonly at: number;
      readonly step: number;
      readonly callId: string;
      readonly tool: string;
      readonly ok: boolean;
      readonly durationMs: number;
      readonly observation: string;
      readonly result?: unknown;
      readonly error?: ToolFailure;
    }
  | {
      readonly type: 'final_answer';
      readonly at: number;
      readonly step: number;
      readonly text: string;
      readonly citations: readonly Citation[];
      readonly toolsUsed: readonly string[];
    }
  | {
      readonly type: 'notice';
      readonly at: number;
      readonly step: number;
      readonly level: 'info' | 'warn';
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly type: 'run_finished';
      readonly at: number;
      readonly runId: string;
      readonly status: RunStatus;
      readonly steps: number;
      readonly usage: TokenUsage;
      readonly wallMs: number;
      readonly modelCalls: number;
      readonly toolCalls: number;
      readonly error?: string;
    };

export interface RunTrace {
  readonly version: number;
  readonly runId: string;
  readonly goal: string;
  readonly model: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly wallMs: number;
  readonly steps: number;
  readonly usage: TokenUsage;
  readonly answer: string | null;
  readonly citations: readonly Citation[];
  readonly events: readonly TraceEvent[];
  readonly error?: string;
  /**
   * Set only when `status` is `rate-limited`. The swarm scheduler needs the
   * provider's own number to re-queue the agent; without it, a 429 would be
   * indistinguishable from any other failure and would get generic backoff.
   */
  readonly rateLimitRetryAfterMs?: number;
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
