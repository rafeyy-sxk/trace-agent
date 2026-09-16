import type { TokenUsage } from '../groq/types';
import type { Citation, RunStatus, TraceEvent } from '../agent/types';

export const SWARM_FORMAT_VERSION = 1;

export type AgentState =
  | 'queued'
  | 'waiting-on-budget'
  | 'running'
  | 'retrying'
  | 'done'
  | 'failed'
  | 'cancelled';

/** States an agent can still leave. Nothing may be in one when a run ends. */
export const NON_TERMINAL_STATES: readonly AgentState[] = [
  'queued',
  'waiting-on-budget',
  'running',
  'retrying',
];

export interface SubGoal {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly goal: string;
}

export interface AgentSummary {
  readonly agentId: string;
  readonly index: number;
  readonly title: string;
  readonly goal: string;
  readonly state: AgentState;
  readonly status: RunStatus | null;
  readonly attempts: number;
  readonly steps: number;
  readonly usage: TokenUsage;
  readonly wallMs: number;
  readonly answer: string | null;
  readonly citations: readonly Citation[];
  readonly error: string | null;
}

export interface SwarmLedger {
  readonly dispatched: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  /** 429s that were re-queued and later succeeded. */
  readonly retriesAbsorbed: number;
  readonly rateLimitHits: number;
  readonly maxConcurrencyReached: number;
  readonly configuredConcurrency: number;
  readonly wallMs: number;
  readonly usage: TokenUsage;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly peakTokensInWindow: number;
  readonly tokenCeiling: number;
  readonly declaredTokenLimit: number;
  readonly budgetWaitMs: number;
}

export interface SwarmReport {
  readonly version: number;
  readonly swarmId: string;
  readonly goal: string;
  readonly model: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly ledger: SwarmLedger;
  readonly agents: readonly AgentSummary[];
  readonly mergedAnswer: string | null;
  readonly citations: readonly Citation[];
}

export type SwarmEvent =
  | {
      readonly type: 'swarm_started';
      readonly at: number;
      readonly swarmId: string;
      readonly goal: string;
      readonly model: string;
      readonly agentCount: number;
      readonly concurrency: number;
      readonly tokenCeiling: number;
    }
  | { readonly type: 'plan_ready'; readonly at: number; readonly subGoals: readonly SubGoal[] }
  | {
      readonly type: 'agent_state';
      readonly at: number;
      readonly agentId: string;
      readonly state: AgentState;
      readonly attempt: number;
      readonly detail?: string;
    }
  | {
      readonly type: 'agent_event';
      readonly at: number;
      readonly agentId: string;
      readonly event: TraceEvent;
    }
  | {
      readonly type: 'budget';
      readonly at: number;
      readonly spentInWindow: number;
      readonly ceiling: number;
      readonly running: number;
      readonly waitingOnBudget: number;
      readonly queued: number;
      readonly cooldownMs: number;
    }
  | {
      readonly type: 'rate_limited';
      readonly at: number;
      readonly agentId: string;
      readonly attempt: number;
      readonly retryAfterMs: number;
      readonly requeued: boolean;
    }
  | { readonly type: 'agent_finished'; readonly at: number; readonly summary: AgentSummary }
  | {
      readonly type: 'merged_answer';
      readonly at: number;
      readonly text: string;
      readonly contributingAgents: readonly string[];
      readonly synthesized: boolean;
    }
  | { readonly type: 'swarm_finished'; readonly at: number; readonly report: SwarmReport };
