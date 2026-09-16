import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../agent/types';
import { citationsFromResult, dedupeCitations } from '../agent/citations';
import { formatDuration, formatTokens, truncateMiddle } from './format';
import { groupTrace } from './group';
import { reduceSwarm, type StreamEnvelope } from './swarm-state';

describe('formatters', () => {
  it('should render durations at a sensible scale', () => {
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(1_500)).toBe('1.50s');
    expect(formatDuration(75_000)).toBe('1m 15s');
    expect(formatDuration(-1)).toBe('—');
  });

  it('should render token counts compactly past ten thousand', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(2_500_000)).toBe('2.50M');
  });

  it('should truncate in the middle so both ends stay readable', () => {
    expect(truncateMiddle('abcdefghij', 5)).toBe('ab…ij');
    expect(truncateMiddle('short', 20)).toBe('short');
  });
});

describe('citation extraction', () => {
  it('should pull URLs straight out of a tool result, not out of the model text', () => {
    const result = {
      summary: { title: 'Tokyo', url: 'https://en.wikipedia.org/wiki/Tokyo' },
      hits: [{ title: 'Greater Tokyo', url: 'https://en.wikipedia.org/wiki/Greater_Tokyo_Area' }],
    };
    const citations = citationsFromResult(result, 'wikipedia', 1);
    expect(citations).toHaveLength(2);
    expect(citations[0]?.title).toBe('Tokyo');
    expect(citations[0]?.tool).toBe('wikipedia');
  });

  it('should ignore values that are not http URLs', () => {
    expect(citationsFromResult({ url: 'file:///etc/passwd' }, 'x', 1)).toHaveLength(0);
    expect(citationsFromResult({ url: 42 }, 'x', 1)).toHaveLength(0);
  });

  it('should dedupe by URL, keeping the first sighting', () => {
    const deduped = dedupeCitations([
      { url: 'https://a.test/', title: 'first', tool: 'x', step: 1 },
      { url: 'https://a.test/', title: 'second', tool: 'y', step: 2 },
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.title).toBe('first');
  });
});

const EVENTS: TraceEvent[] = [
  {
    type: 'run_started',
    at: 1_000,
    runId: 'r1',
    goal: 'g',
    model: 'm',
    maxSteps: 4,
    tools: ['calculator'],
  },
  { type: 'step_started', at: 1_010, step: 1 },
  {
    type: 'model_call',
    at: 1_020,
    step: 1,
    model: 'm',
    latencyMs: 200,
    usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    finishReason: 'tool_calls',
    toolCallCount: 1,
  },
  { type: 'thought', at: 1_021, step: 1, text: 'let me compute', source: 'reasoning' },
  { type: 'tool_call', at: 1_030, step: 1, callId: 'c1', tool: 'calculator', args: { expression: '2+2' } },
  {
    type: 'tool_result',
    at: 1_040,
    step: 1,
    callId: 'c1',
    tool: 'calculator',
    ok: true,
    durationMs: 3,
    observation: '2+2 = 4',
    result: { value: 4 },
  },
  { type: 'step_started', at: 1_050, step: 2 },
  {
    type: 'model_call',
    at: 1_060,
    step: 2,
    model: 'm',
    latencyMs: 150,
    usage: { promptTokens: 70, completionTokens: 15, totalTokens: 85 },
    finishReason: 'stop',
    toolCallCount: 0,
  },
  { type: 'final_answer', at: 1_070, step: 2, text: 'It is 4.', citations: [], toolsUsed: ['calculator'] },
  {
    type: 'run_finished',
    at: 1_080,
    runId: 'r1',
    status: 'completed',
    steps: 2,
    usage: { promptTokens: 120, completionTokens: 25, totalTokens: 145 },
    wallMs: 80,
    modelCalls: 2,
    toolCalls: 1,
  },
];

describe('groupTrace', () => {
  it('should fold a flat event stream into ordered steps', () => {
    const grouped = groupTrace(EVENTS);
    expect(grouped.steps).toHaveLength(2);
    expect(grouped.steps[0]?.thought).toBe('let me compute');
    expect(grouped.steps[0]?.calls[0]?.result?.observation).toBe('2+2 = 4');
    expect(grouped.steps[1]?.calls).toHaveLength(0);
    expect(grouped.status).toBe('completed');
    expect(grouped.finalAnswer?.text).toBe('It is 4.');
  });

  it('should report a run still in flight as running', () => {
    const grouped = groupTrace(EVENTS.slice(0, 5));
    expect(grouped.status).toBe('running');
    expect(grouped.steps[0]?.calls[0]?.result).toBeNull();
  });

  it('should total tokens from the model calls before the run finishes', () => {
    const grouped = groupTrace(EVENTS.slice(0, 4));
    expect(grouped.usage.totalTokens).toBe(60);
  });

  it('should tolerate a result that arrives without its matching call', () => {
    const orphan = groupTrace([EVENTS[0]!, EVENTS[5]!]);
    expect(orphan.steps[0]?.calls).toHaveLength(1);
    expect(orphan.steps[0]?.calls[0]?.args).toBeNull();
  });
});

describe('reduceSwarm', () => {
  const stream: StreamEnvelope[] = [
    { type: 'plan_source', at: 1, source: 'model' },
    {
      type: 'swarm_started',
      at: 2,
      swarmId: 's1',
      goal: 'g',
      model: 'm',
      agentCount: 2,
      concurrency: 2,
      tokenCeiling: 7_200,
    },
    {
      type: 'plan_ready',
      at: 3,
      subGoals: [
        { id: 'agent_1', index: 0, title: 'A', goal: 'first' },
        { id: 'agent_2', index: 1, title: 'B', goal: 'second' },
      ],
    },
    { type: 'agent_state', at: 4, agentId: 'agent_1', state: 'running', attempt: 1 },
    { type: 'agent_state', at: 5, agentId: 'agent_2', state: 'waiting-on-budget', attempt: 1 },
    {
      type: 'budget',
      at: 6,
      spentInWindow: 3_000,
      ceiling: 7_200,
      running: 1,
      waitingOnBudget: 1,
      queued: 0,
      cooldownMs: 0,
    },
    {
      type: 'agent_event',
      at: 7,
      agentId: 'agent_1',
      event: { type: 'tool_call', at: 7, step: 1, callId: 'c', tool: 'wikipedia', args: {} },
    },
    { type: 'rate_limited', at: 8, agentId: 'agent_2', attempt: 1, retryAfterMs: 3_000, requeued: true },
  ];

  it('should build a board with one entry per planned agent', () => {
    const state = reduceSwarm(stream);
    expect(state.agents).toHaveLength(2);
    expect(state.agents[0]?.state).toBe('running');
    expect(state.agents[1]?.state).toBe('waiting-on-budget');
    expect(state.planSource).toBe('model');
    expect(state.tokenCeiling).toBe(7_200);
  });

  it('should track the current tool and the rate limits an agent has seen', () => {
    const state = reduceSwarm(stream);
    expect(state.agents[0]?.currentTool).toBe('wikipedia');
    expect(state.agents[1]?.rateLimitHits).toBe(1);
  });

  it('should keep the latest budget snapshot and a history of them', () => {
    const state = reduceSwarm(stream);
    expect(state.budget?.spentInWindow).toBe(3_000);
    expect(state.budgetHistory).toHaveLength(1);
  });

  it('should let the final report override every live state', () => {
    const state = reduceSwarm([
      ...stream,
      {
        type: 'swarm_finished',
        at: 9,
        report: {
          version: 1,
          swarmId: 's1',
          goal: 'g',
          model: 'm',
          startedAt: 2,
          finishedAt: 9,
          ledger: {
            dispatched: 2,
            completed: 2,
            failed: 0,
            cancelled: 0,
            retriesAbsorbed: 1,
            rateLimitHits: 1,
            maxConcurrencyReached: 2,
            configuredConcurrency: 2,
            wallMs: 7,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            modelCalls: 3,
            toolCalls: 1,
            peakTokensInWindow: 3_000,
            tokenCeiling: 7_200,
            declaredTokenLimit: 8_000,
            budgetWaitMs: 500,
          },
          agents: [
            {
              agentId: 'agent_1',
              index: 0,
              title: 'A',
              goal: 'first',
              state: 'done',
              status: 'completed',
              attempts: 1,
              steps: 1,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              wallMs: 5,
              answer: 'ok',
              citations: [],
              error: null,
            },
            {
              agentId: 'agent_2',
              index: 1,
              title: 'B',
              goal: 'second',
              state: 'done',
              status: 'completed',
              attempts: 2,
              steps: 1,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              wallMs: 6,
              answer: 'ok too',
              citations: [],
              error: null,
            },
          ],
          mergedAnswer: 'merged',
          citations: [],
        },
      },
    ]);
    expect(state.agents.every((agent) => agent.state === 'done')).toBe(true);
    expect(state.report?.ledger.retriesAbsorbed).toBe(1);
  });

  it('should surface a stream error rather than swallowing it', () => {
    const state = reduceSwarm([...stream, { type: 'stream_error', at: 10, message: 'upstream died' }]);
    expect(state.streamError).toBe('upstream died');
  });
});
