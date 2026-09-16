import type { TraceEvent } from '../agent/types';
import type { TokenUsage } from '../groq/types';
import type { AgentState, SubGoal, SwarmEvent, SwarmReport } from '../swarm/types';

export interface AgentBoardEntry {
  readonly agentId: string;
  readonly index: number;
  title: string;
  goal: string;
  state: AgentState;
  attempt: number;
  detail: string | null;
  currentStep: number;
  currentTool: string | null;
  toolCalls: number;
  usage: TokenUsage;
  events: TraceEvent[];
  answer: string | null;
  error: string | null;
  wallMs: number;
  rateLimitHits: number;
}

export interface BudgetSnapshot {
  readonly at: number;
  readonly spentInWindow: number;
  readonly ceiling: number;
  readonly running: number;
  readonly waitingOnBudget: number;
  readonly queued: number;
  readonly cooldownMs: number;
}

export interface SwarmBoardState {
  swarmId: string | null;
  goal: string;
  model: string;
  agentCount: number;
  concurrency: number;
  tokenCeiling: number;
  startedAt: number | null;
  planSource: 'model' | 'fallback' | null;
  planError: string | null;
  agents: AgentBoardEntry[];
  budget: BudgetSnapshot | null;
  budgetHistory: BudgetSnapshot[];
  merged: { text: string; synthesized: boolean } | null;
  report: SwarmReport | null;
  streamError: string | null;
}

const BUDGET_HISTORY_POINTS = 120;

export function emptySwarmBoard(): SwarmBoardState {
  return {
    swarmId: null,
    goal: '',
    model: '',
    agentCount: 0,
    concurrency: 0,
    tokenCeiling: 0,
    startedAt: null,
    planSource: null,
    planError: null,
    agents: [],
    budget: null,
    budgetHistory: [],
    merged: null,
    report: null,
    streamError: null,
  };
}

function blankAgent(subGoal: SubGoal): AgentBoardEntry {
  return {
    agentId: subGoal.id,
    index: subGoal.index,
    title: subGoal.title,
    goal: subGoal.goal,
    state: 'queued',
    attempt: 0,
    detail: null,
    currentStep: 0,
    currentTool: null,
    toolCalls: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    events: [],
    answer: null,
    error: null,
    wallMs: 0,
    rateLimitHits: 0,
  };
}

/** Events the swarm stream carries that are not `SwarmEvent`s. */
export type StreamEnvelope =
  | SwarmEvent
  | { type: 'plan_source'; at: number; source: 'model' | 'fallback'; error?: string }
  | { type: 'stream_error'; at: number; message: string };

/**
 * Fold the swarm stream into board state.
 *
 * A pure reducer over the raw event list, recomputed from scratch on each
 * render pass. It is O(events), which is why the stream hook batches: the
 * cost is paid once per frame, not once per event.
 */
export function reduceSwarm(events: readonly StreamEnvelope[]): SwarmBoardState {
  const state = emptySwarmBoard();
  const byId = new Map<string, AgentBoardEntry>();

  for (const event of events) {
    switch (event.type) {
      case 'swarm_started':
        state.swarmId = event.swarmId;
        state.goal = event.goal;
        state.model = event.model;
        state.agentCount = event.agentCount;
        state.concurrency = event.concurrency;
        state.tokenCeiling = event.tokenCeiling;
        state.startedAt = event.at;
        break;
      case 'plan_source':
        state.planSource = event.source;
        state.planError = event.error ?? null;
        break;
      case 'plan_ready':
        for (const subGoal of event.subGoals) {
          if (!byId.has(subGoal.id)) byId.set(subGoal.id, blankAgent(subGoal));
        }
        break;
      case 'agent_state': {
        const agent = byId.get(event.agentId);
        if (!agent) break;
        agent.state = event.state;
        agent.attempt = Math.max(agent.attempt, event.attempt);
        agent.detail = event.detail ?? null;
        if (event.state === 'running' || event.state === 'waiting-on-budget') agent.answer = null;
        break;
      }
      case 'agent_event': {
        const agent = byId.get(event.agentId);
        if (!agent) break;
        agent.events.push(event.event);
        applyTraceEvent(agent, event.event);
        break;
      }
      case 'rate_limited': {
        const agent = byId.get(event.agentId);
        if (agent) agent.rateLimitHits += 1;
        break;
      }
      case 'budget': {
        const snapshot: BudgetSnapshot = {
          at: event.at,
          spentInWindow: event.spentInWindow,
          ceiling: event.ceiling,
          running: event.running,
          waitingOnBudget: event.waitingOnBudget,
          queued: event.queued,
          cooldownMs: event.cooldownMs,
        };
        state.budget = snapshot;
        state.budgetHistory.push(snapshot);
        if (state.budgetHistory.length > BUDGET_HISTORY_POINTS) state.budgetHistory.shift();
        break;
      }
      case 'agent_finished': {
        const agent = byId.get(event.summary.agentId);
        if (!agent) break;
        agent.state = event.summary.state;
        agent.answer = event.summary.answer;
        agent.error = event.summary.error;
        agent.usage = event.summary.usage;
        agent.wallMs = event.summary.wallMs;
        agent.attempt = event.summary.attempts;
        agent.currentTool = null;
        break;
      }
      case 'merged_answer':
        state.merged = { text: event.text, synthesized: event.synthesized };
        break;
      case 'swarm_finished':
        state.report = event.report;
        for (const summary of event.report.agents) {
          const agent = byId.get(summary.agentId);
          if (!agent) continue;
          agent.state = summary.state;
          agent.answer = summary.answer;
          agent.error = summary.error;
          agent.usage = summary.usage;
          agent.wallMs = summary.wallMs;
          agent.currentTool = null;
        }
        break;
      case 'stream_error':
        state.streamError = event.message;
        break;
      default:
        break;
    }
  }

  state.agents = [...byId.values()].sort((a, b) => a.index - b.index);
  return state;
}

function applyTraceEvent(agent: AgentBoardEntry, event: TraceEvent): void {
  switch (event.type) {
    case 'step_started':
      agent.currentStep = event.step;
      break;
    case 'model_call':
      agent.usage = {
        promptTokens: agent.usage.promptTokens + event.usage.promptTokens,
        completionTokens: agent.usage.completionTokens + event.usage.completionTokens,
        totalTokens: agent.usage.totalTokens + event.usage.totalTokens,
      };
      break;
    case 'tool_call':
      agent.currentTool = event.tool;
      break;
    case 'tool_result':
      agent.currentTool = null;
      agent.toolCalls += 1;
      break;
    case 'final_answer':
      agent.answer = event.text;
      break;
    default:
      break;
  }
}

export const AGENT_STATE_TONE: Record<AgentState, 'neutral' | 'info' | 'warn' | 'ok' | 'danger' | 'accent'> = {
  queued: 'neutral',
  'waiting-on-budget': 'warn',
  running: 'info',
  retrying: 'warn',
  done: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
};

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  queued: 'queued',
  'waiting-on-budget': 'waiting on budget',
  running: 'running',
  retrying: 'retrying',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};
