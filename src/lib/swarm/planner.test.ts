import { describe, expect, it } from 'vitest';
import { scriptedChat } from '@/test/mocks';
import { fallbackPlan, MAX_AGENTS, planSubGoals } from './planner';

describe('fallbackPlan', () => {
  it('should produce exactly the requested number of distinct sub-goals', () => {
    const plan = fallbackPlan('state of fusion energy', 12);
    expect(plan).toHaveLength(12);
    expect(new Set(plan.map((item) => item.goal)).size).toBe(12);
    expect(new Set(plan.map((item) => item.id)).size).toBe(12);
    expect(plan.every((item) => item.goal.includes('state of fusion energy'))).toBe(true);
  });

  it('should stay distinct past the number of built-in angles', () => {
    const plan = fallbackPlan('anything', MAX_AGENTS);
    expect(plan).toHaveLength(MAX_AGENTS);
    expect(new Set(plan.map((item) => item.title)).size).toBe(MAX_AGENTS);
  });

  it('should clamp a request beyond the hard ceiling', () => {
    expect(fallbackPlan('x', 5_000)).toHaveLength(MAX_AGENTS);
    expect(fallbackPlan('x', 0)).toHaveLength(1);
  });
});

describe('planSubGoals', () => {
  it('should use the model plan when the model returns valid JSON', async () => {
    const chat = scriptedChat([
      {
        content: JSON.stringify({
          subgoals: [
            { title: 'Physics', goal: 'Explain the physics of magnetic confinement fusion.' },
            { title: 'Money', goal: 'Find how much public money went into fusion in 2025.' },
          ],
        }),
      },
    ]);
    const plan = await planSubGoals({ goal: 'fusion', count: 2, model: 'm', chat: chat.fn });

    expect(plan.source).toBe('model');
    expect(plan.subGoals).toHaveLength(2);
    expect(plan.subGoals[0]?.title).toBe('Physics');
    expect(plan.subGoals[0]?.id).toBe('agent_1');
  });

  it('should top up a short plan from the deterministic angles rather than running fewer agents', async () => {
    const chat = scriptedChat([
      { content: JSON.stringify({ subgoals: [{ title: 'One', goal: 'Just the one angle here.' }] }) },
    ]);
    const plan = await planSubGoals({ goal: 'fusion', count: 5, model: 'm', chat: chat.fn });
    expect(plan.subGoals).toHaveLength(5);
    expect(plan.subGoals[0]?.title).toBe('One');
  });

  it('should truncate an over-long plan to the requested count', async () => {
    const chat = scriptedChat([
      {
        content: JSON.stringify({
          subgoals: Array.from({ length: 9 }, (_unused, index) => ({
            title: `T${index}`,
            goal: `Research angle number ${index} in detail.`,
          })),
        }),
      },
    ]);
    const plan = await planSubGoals({ goal: 'fusion', count: 3, model: 'm', chat: chat.fn });
    expect(plan.subGoals).toHaveLength(3);
  });

  it('should fall back, and say so, when the model returns prose instead of JSON', async () => {
    const chat = scriptedChat([{ content: 'Sure! Here are some ideas you might like.' }]);
    const plan = await planSubGoals({ goal: 'fusion', count: 4, model: 'm', chat: chat.fn });

    expect(plan.source).toBe('fallback');
    expect(plan.subGoals).toHaveLength(4);
    expect(plan.error).toContain('parseable JSON');
  });

  it('should fall back when the model JSON does not match the schema', async () => {
    const chat = scriptedChat([{ content: JSON.stringify({ subgoals: [{ title: 'x' }] }) }]);
    const plan = await planSubGoals({ goal: 'fusion', count: 3, model: 'm', chat: chat.fn });
    expect(plan.source).toBe('fallback');
    expect(plan.error).toBeDefined();
  });

  it('should fall back rather than fail when the planner call throws', async () => {
    const chat = scriptedChat([{ throws: new Error('planner unavailable') }]);
    const plan = await planSubGoals({ goal: 'fusion', count: 6, model: 'm', chat: chat.fn });
    expect(plan.source).toBe('fallback');
    expect(plan.subGoals).toHaveLength(6);
    expect(plan.error).toContain('planner unavailable');
  });

  it('should not spend a model call for a single-agent run', async () => {
    const chat = scriptedChat([{ content: '{}' }]);
    const plan = await planSubGoals({ goal: 'fusion', count: 1, model: 'm', chat: chat.fn });
    expect(chat.callCount()).toBe(0);
    expect(plan.subGoals[0]?.goal).toBe('fusion');
  });
});
