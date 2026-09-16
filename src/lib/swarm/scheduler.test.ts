import { describe, expect, it } from 'vitest';
import { driveClock, VirtualClock } from '@/test/clock';
import { buildResponse } from '@/test/mocks';
import type { ChatFn, ChatRequest } from '../groq/types';
import { GroqRateLimitError } from '../groq/types';
import { calculatorTool } from '../tools';
import type { AnyTool } from '../tools/types';
import { TokenBudget } from './budget';
import { fallbackPlan } from './planner';
import { runSwarm, type SwarmOptions } from './scheduler';
import { NON_TERMINAL_STATES, type SwarmEvent, type SwarmReport } from './types';

const TOOLS = [calculatorTool] as unknown as readonly AnyTool[];

interface CallRecord {
  readonly at: number;
  readonly tokens: number;
}

interface Harness {
  readonly chat: ChatFn;
  readonly calls: CallRecord[];
  readonly count: () => number;
}

/**
 * A model that answers immediately and records when it was called and what it
 * cost, so a test can reconstruct the rolling window after the fact.
 */
function recordingChat(
  clock: VirtualClock,
  behaviour: (request: ChatRequest, callIndex: number) => 'ok' | 'rate-limit' | 'error',
  tokensPerCall = 240,
): Harness {
  const calls: CallRecord[] = [];
  let index = 0;
  const chat: ChatFn = async (request) => {
    const callIndex = index;
    index += 1;
    const verdict = behaviour(request, callIndex);
    if (verdict === 'rate-limit') throw new GroqRateLimitError('{}', 3_000);
    if (verdict === 'error') throw new Error('upstream exploded');
    calls.push({ at: clock.now(), tokens: tokensPerCall });
    return buildResponse(request, {
      content: `answer ${callIndex}`,
      usage: { prompt: tokensPerCall - 40, completion: 40 },
    });
  };
  return { chat, calls, count: () => index };
}

function swarmOptions(
  clock: VirtualClock,
  chat: ChatFn,
  agents: number,
  overrides: Partial<SwarmOptions> = {},
): SwarmOptions {
  return {
    goal: 'test goal',
    subGoals: fallbackPlan('test goal', agents),
    model: 'test-model',
    chat,
    budget: new TokenBudget({ limitPerMinute: 4_000, now: clock.now, headroom: 0.1 }),
    concurrency: 8,
    maxStepsPerAgent: 1,
    maxTokensPerCall: 300,
    tools: TOOLS,
    now: clock.now,
    sleep: clock.sleep,
    synthesize: false,
    budgetSampleMs: 0,
    ...overrides,
  };
}

async function runToCompletion(
  clock: VirtualClock,
  options: SwarmOptions,
): Promise<{ report: SwarmReport; events: SwarmEvent[] }> {
  const events: SwarmEvent[] = [];
  const iterator = runSwarm(options);
  const work = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return next.value;
      events.push(next.value);
    }
  })();
  const report = await driveClock(clock, work);
  return { report, events };
}

/** Replay agent_state events to measure how many held a worker slot at once. */
function maxSimultaneousAgents(events: readonly SwarmEvent[]): number {
  const holding = new Set<string>();
  let peak = 0;
  for (const event of events) {
    if (event.type !== 'agent_state') continue;
    if (event.state === 'running' || event.state === 'waiting-on-budget') holding.add(event.agentId);
    else holding.delete(event.agentId);
    peak = Math.max(peak, holding.size);
  }
  return peak;
}

/** The largest total spend inside any 60-second window of the recorded calls. */
function peakRollingSpend(calls: readonly CallRecord[], windowMs = 60_000): number {
  let peak = 0;
  for (const anchor of calls) {
    const total = calls
      .filter((call) => call.at > anchor.at - windowMs && call.at <= anchor.at)
      .reduce((sum, call) => sum + call.tokens, 0);
    peak = Math.max(peak, total);
  }
  return peak;
}

describe('swarm scheduler — 100 agents on a small budget', () => {
  it('should complete all 100 agents without ever exceeding the rolling token window', async () => {
    const clock = new VirtualClock();
    const harness = recordingChat(clock, () => 'ok');
    const options = swarmOptions(clock, harness.chat, 100, { concurrency: 25 });
    const { report } = await runToCompletion(clock, options);

    expect(report.ledger.dispatched).toBe(100);
    expect(report.ledger.completed).toBe(100);
    expect(report.ledger.failed).toBe(0);
    expect(report.ledger.cancelled).toBe(0);
    expect(report.agents).toHaveLength(100);
    expect(report.agents.every((agent) => agent.answer !== null)).toBe(true);

    // The budget's own view: no reservation ever pushed the window past the ceiling.
    expect(report.ledger.peakTokensInWindow).toBeLessThanOrEqual(report.ledger.tokenCeiling);

    // An independent view, reconstructed from the real usage of every call made.
    expect(peakRollingSpend(harness.calls)).toBeLessThanOrEqual(report.ledger.tokenCeiling);

    // Positive control: the same measurement DOES find a breach when the gate is bypassed.
    const unthrottled = harness.calls.map((call) => ({ ...call, at: clock.now() }));
    expect(peakRollingSpend(unthrottled)).toBeGreaterThan(report.ledger.tokenCeiling);
  });

  it('should hold agents at the gate rather than letting any of them see a 429', async () => {
    const clock = new VirtualClock();
    const harness = recordingChat(clock, () => 'ok');
    const options = swarmOptions(clock, harness.chat, 60, { concurrency: 20 });
    const { report, events } = await runToCompletion(clock, options);

    expect(report.ledger.rateLimitHits).toBe(0);
    expect(report.ledger.budgetWaitMs).toBeGreaterThan(0);
    const heldAtGate = events.filter(
      (event) => event.type === 'agent_state' && event.state === 'waiting-on-budget',
    );
    expect(heldAtGate.length).toBeGreaterThan(0);
  });
});

describe('swarm scheduler — concurrency cap', () => {
  it('should never let more agents hold a worker slot than the configured cap', async () => {
    const clock = new VirtualClock();
    const harness = recordingChat(clock, () => 'ok');
    const cap = 6;
    const options = swarmOptions(clock, harness.chat, 40, { concurrency: cap });
    const { report, events } = await runToCompletion(clock, options);

    expect(report.ledger.maxConcurrencyReached).toBeLessThanOrEqual(cap);
    expect(report.ledger.configuredConcurrency).toBe(cap);
    expect(maxSimultaneousAgents(events)).toBeLessThanOrEqual(cap);
    // And the cap was genuinely reached, so the assertion above is not vacuous.
    expect(report.ledger.maxConcurrencyReached).toBe(cap);
  });
});

describe('swarm scheduler — 429 storm', () => {
  it('should absorb a storm of rate limits and still finish every agent', async () => {
    const clock = new VirtualClock();
    let rateLimited = 0;
    const harness = recordingChat(clock, () => {
      // The first 40 model calls all come back 429.
      if (rateLimited < 40) {
        rateLimited += 1;
        return 'rate-limit';
      }
      return 'ok';
    });
    const options = swarmOptions(clock, harness.chat, 20, {
      concurrency: 10,
      maxAttempts: 6,
    });
    const { report } = await runToCompletion(clock, options);

    expect(rateLimited).toBe(40);
    expect(report.ledger.rateLimitHits).toBeGreaterThanOrEqual(20);
    expect(report.ledger.completed).toBe(20);
    expect(report.ledger.failed).toBe(0);
    expect(report.ledger.retriesAbsorbed).toBeGreaterThan(0);
    expect(report.agents.every((agent) => agent.state === 'done')).toBe(true);
  });

  it('should report an agent failed once it exhausts its attempt cap, not drop it', async () => {
    const clock = new VirtualClock();
    const harness = recordingChat(clock, () => 'rate-limit');
    const options = swarmOptions(clock, harness.chat, 3, {
      concurrency: 3,
      maxAttempts: 2,
    });
    const { report } = await runToCompletion(clock, options);

    expect(report.ledger.completed).toBe(0);
    expect(report.ledger.failed).toBe(3);
    expect(report.agents.every((agent) => agent.attempts === 2)).toBe(true);
    expect(report.agents.every((agent) => agent.error !== null)).toBe(true);
  });
});

describe('swarm scheduler — a permanently failing agent', () => {
  it('should report it failed and let every other agent finish', async () => {
    const clock = new VirtualClock();
    const doomed = 'agent_2';
    const harness = recordingChat(clock, (request) => {
      const text = request.messages.map((message) => message.content).join(' ');
      return text.includes('most important quantities') ? 'error' : 'ok';
    });
    const options = swarmOptions(clock, harness.chat, 5, {
      concurrency: 5,
      maxAttempts: 3,
    });
    const { report } = await runToCompletion(clock, options);

    const failed = report.agents.filter((agent) => agent.state === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.agentId).toBe(doomed);
    expect(failed[0]?.attempts).toBe(3);
    expect(failed[0]?.error).toContain('upstream exploded');
    expect(report.ledger.completed).toBe(4);
    expect(report.agents.filter((agent) => agent.state === 'done')).toHaveLength(4);
  });

  it('should still produce a merged answer from the agents that did succeed', async () => {
    const clock = new VirtualClock();
    const harness = recordingChat(clock, (request) => {
      const text = request.messages.map((message) => message.content).join(' ');
      return text.includes('most important quantities') ? 'error' : 'ok';
    });
    const options = swarmOptions(clock, harness.chat, 4, { concurrency: 4, maxAttempts: 2 });
    const { report } = await runToCompletion(clock, options);

    expect(report.mergedAnswer).not.toBeNull();
    expect(report.mergedAnswer).toContain('3 of 4 agents returned an answer');
  });
});

describe('swarm scheduler — cancellation', () => {
  it('should leave no agent stuck in a non-terminal state', async () => {
    const clock = new VirtualClock();
    const controller = new AbortController();
    const harness = recordingChat(clock, () => 'ok');
    const options = swarmOptions(clock, harness.chat, 40, {
      concurrency: 10,
      signal: controller.signal,
    });

    const events: SwarmEvent[] = [];
    const iterator = runSwarm(options);
    const work = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return next.value;
        events.push(next.value);
        // Abort as soon as a handful of agents have actually started.
        if (
          !controller.signal.aborted &&
          events.filter((event) => event.type === 'agent_state' && event.state === 'running')
            .length >= 5
        ) {
          controller.abort();
        }
      }
    })();

    const report = await driveClock(clock, work);

    const stuck = report.agents.filter((agent) => NON_TERMINAL_STATES.includes(agent.state));
    expect(stuck).toEqual([]);
    expect(report.ledger.completed + report.ledger.failed + report.ledger.cancelled).toBe(40);
    expect(report.ledger.cancelled).toBeGreaterThan(0);
  });

  it('should stop making model calls once cancelled', async () => {
    const clock = new VirtualClock();
    const controller = new AbortController();
    const harness = recordingChat(clock, () => 'ok');
    const options = swarmOptions(clock, harness.chat, 30, {
      concurrency: 5,
      signal: controller.signal,
    });

    const iterator = runSwarm(options);
    let seen = 0;
    const work = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return next.value;
        seen += 1;
        if (seen === 12) controller.abort();
      }
    })();
    await driveClock(clock, work);
    const callsAtAbort = harness.count();

    // Nothing new should start after the abort has been processed.
    await driveClock(clock, Promise.resolve());
    expect(harness.count()).toBe(callsAtAbort);
    expect(callsAtAbort).toBeLessThan(30);
  });
});

describe('swarm scheduler — the ledger', () => {
  it('should compute every ledger figure from what actually happened', async () => {
    const clock = new VirtualClock();
    const harness = recordingChat(clock, () => 'ok', 200);
    const options = swarmOptions(clock, harness.chat, 12, { concurrency: 4 });
    const { report } = await runToCompletion(clock, options);

    expect(report.ledger.modelCalls).toBe(harness.count());
    expect(report.ledger.usage.totalTokens).toBe(harness.count() * 200);
    expect(report.ledger.wallMs).toBeGreaterThan(0);
    expect(report.ledger.declaredTokenLimit).toBe(4_000);
    expect(report.ledger.tokenCeiling).toBe(3_600);
    expect(report.agents.map((agent) => agent.index)).toEqual([...Array(12).keys()]);
  });

  it('should attribute the merged answer to the agents that contributed', async () => {
    const clock = new VirtualClock();
    const harness = recordingChat(clock, () => 'ok');
    const options = swarmOptions(clock, harness.chat, 3, { concurrency: 3 });
    const { events } = await runToCompletion(clock, options);
    const merged = events.find((event) => event.type === 'merged_answer');
    expect(merged?.type === 'merged_answer' && merged.contributingAgents).toEqual([
      'agent_1',
      'agent_2',
      'agent_3',
    ]);
    expect(merged?.type === 'merged_answer' && merged.synthesized).toBe(false);
  });
});
