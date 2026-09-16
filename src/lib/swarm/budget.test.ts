import { describe, expect, it } from 'vitest';
import { VirtualClock } from '@/test/clock';
import { estimateCallTokens, estimatePromptTokens, TokenBudget } from './budget';

function budgetOn(clock: VirtualClock, limit: number, headroom = 0): TokenBudget {
  return new TokenBudget({ limitPerMinute: limit, now: clock.now, headroom });
}

describe('TokenBudget', () => {
  it('should apply headroom so we never aim at exactly the provider ceiling', () => {
    const budget = new TokenBudget({ limitPerMinute: 8_000, headroom: 0.1 });
    expect(budget.declaredLimit).toBe(8_000);
    expect(budget.limit).toBe(7_200);
  });

  it('should admit spend up to the ceiling and refuse the call that would cross it', () => {
    const clock = new VirtualClock();
    const budget = budgetOn(clock, 1_000);
    expect(budget.tryReserve(600)).not.toBeNull();
    expect(budget.tryReserve(400)).not.toBeNull();
    expect(budget.tryReserve(1)).toBeNull();
    expect(budget.spentInWindow()).toBe(1_000);
  });

  it('should tell a caller exactly how long to wait for room', () => {
    const clock = new VirtualClock();
    const budget = budgetOn(clock, 1_000);
    budget.tryReserve(800);
    expect(budget.waitFor(100)).toBe(0);
    const wait = budget.waitFor(500);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60_000);
  });

  it('should free spend as it ages out of the rolling window', () => {
    const clock = new VirtualClock();
    const budget = budgetOn(clock, 1_000);
    budget.tryReserve(1_000);
    expect(budget.waitFor(500)).toBeGreaterThan(0);
    clock.tick(60_001);
    expect(budget.spentInWindow()).toBe(0);
    expect(budget.waitFor(500)).toBe(0);
  });

  it('should reconcile an estimate against the real cost so unused budget comes back', () => {
    const clock = new VirtualClock();
    const budget = budgetOn(clock, 1_000);
    const reservation = budget.tryReserve(900);
    expect(reservation).not.toBeNull();
    expect(budget.spentInWindow()).toBe(900);
    budget.settle(reservation!, 120);
    expect(budget.spentInWindow()).toBe(120);
  });

  it('should give the whole estimate back when a call never reached the provider', () => {
    const clock = new VirtualClock();
    const budget = budgetOn(clock, 1_000);
    const reservation = budget.tryReserve(900)!;
    budget.release(reservation);
    expect(budget.spentInWindow()).toBe(0);
  });

  it('should hold everyone for the cooldown after a real 429', () => {
    const clock = new VirtualClock();
    const budget = budgetOn(clock, 10_000);
    budget.penalise(5_000);
    expect(budget.waitFor(10)).toBe(5_000);
    expect(budget.tryReserve(10)).toBeNull();
  });

  it('should report -1 for a call that can never fit, rather than waiting forever', () => {
    const clock = new VirtualClock();
    const budget = budgetOn(clock, 500);
    expect(budget.waitFor(5_000)).toBe(-1);
  });

  it('should adopt the ceiling the provider reports and ignore a nonsense one', () => {
    const budget = new TokenBudget({ limitPerMinute: 8_000, headroom: 0 });
    expect(budget.calibrate(30_000)).toBe(true);
    expect(budget.limit).toBe(30_000);
    expect(budget.calibrate(30_000)).toBe(false);
    expect(budget.calibrate(0)).toBe(false);
    expect(budget.limit).toBe(30_000);
  });
});

describe('token estimation', () => {
  it('should over-count rather than under-count, because the number gates dispatch', () => {
    // 400 characters of plain English is roughly 100 real tokens.
    const messages = [{ content: 'a'.repeat(400) }];
    expect(estimatePromptTokens(messages)).toBeGreaterThan(100);
  });

  it('should include the completion cap and tool specs in a per-call upper bound', () => {
    const messages = [{ content: 'hello' }];
    expect(estimateCallTokens(messages, 700, 500)).toBeGreaterThanOrEqual(1_200);
  });
});
