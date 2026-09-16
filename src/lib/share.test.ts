import { describe, expect, it } from 'vitest';
import type { RunTrace } from './agent/types';
import { decodeTrace, encodeTrace, isRunTrace, TraceDecodeError } from './share';

function makeTrace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    version: 1,
    runId: 'run_test',
    goal: 'population of Tokyo',
    model: 'openai/gpt-oss-120b',
    status: 'completed',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_004_000,
    wallMs: 4_000,
    steps: 2,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    answer: 'About 14 million in the city proper.',
    citations: [
      { title: 'Tokyo', url: 'https://en.wikipedia.org/wiki/Tokyo', tool: 'wikipedia', step: 1 },
    ],
    events: [
      {
        type: 'run_started',
        at: 1_700_000_000_000,
        runId: 'run_test',
        goal: 'population of Tokyo',
        model: 'openai/gpt-oss-120b',
        maxSteps: 6,
        tools: ['wikipedia'],
      },
      {
        type: 'tool_result',
        at: 1_700_000_001_000,
        step: 1,
        callId: 'c1',
        tool: 'wikipedia',
        ok: true,
        durationMs: 420,
        observation: 'Tokyo is the capital of Japan.',
        result: { summary: { extract: 'Tokyo is the capital of Japan.' } },
      },
    ],
    ...overrides,
  };
}

describe('trace sharing', () => {
  it('should round-trip a trace through the URL token at full fidelity', async () => {
    const trace = makeTrace();
    const payload = await encodeTrace(trace);
    expect(payload.fidelity).toBe('full');
    expect(payload.token.startsWith('g1.')).toBe(true);

    const decoded = await decodeTrace(payload.token);
    expect(decoded.runId).toBe(trace.runId);
    expect(decoded.answer).toBe(trace.answer);
    expect(decoded.events).toHaveLength(2);
  });

  it('should produce a token that is URL-safe', async () => {
    const payload = await encodeTrace(makeTrace());
    const body = payload.token.slice(3);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(body)).toBe(body);
  });

  it('should shed raw tool payloads before it sheds steps when a trace is huge', async () => {
    // Incompressible text, because gzip flattens repeated characters to nothing
    // and a trace of 200 identical strings would fit in a URL comfortably.
    let seed = 1;
    const noise = (length: number): string => {
      let out = '';
      for (let i = 0; i < length; i += 1) {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        out += String.fromCharCode(33 + (seed % 90));
      }
      return out;
    };
    const huge = makeTrace({
      events: Array.from({ length: 200 }, (_unused, index) => ({
        type: 'tool_result' as const,
        at: 1_700_000_000_000 + index,
        step: index,
        callId: `c${index}`,
        tool: 'fetch_url',
        ok: true,
        durationMs: 100,
        observation: noise(2_000),
        result: { text: noise(12_000) },
      })),
    });
    const payload = await encodeTrace(huge);
    expect(payload.fidelity).not.toBe('full');
    if (payload.fidelity !== 'too-large') {
      const decoded = await decodeTrace(payload.token);
      expect(decoded.events).toHaveLength(200);
      expect(decoded.events.every((event) => !('result' in event))).toBe(true);
    }
  });

  it('should reject a token with an unknown prefix', async () => {
    await expect(decodeTrace('zz.abcdef')).rejects.toBeInstanceOf(TraceDecodeError);
  });

  it('should reject a token that decodes to something that is not a trace', async () => {
    const notATrace = await encodeTrace({ hello: 'world' } as unknown as RunTrace);
    await expect(decodeTrace(notATrace.token)).rejects.toBeInstanceOf(TraceDecodeError);
  });

  it('should reject corrupted bytes rather than crashing', async () => {
    await expect(decodeTrace('g1.not-real-gzip-bytes')).rejects.toBeInstanceOf(TraceDecodeError);
  });

  it('should validate the shape of an uploaded trace, since a link is untrusted input', () => {
    expect(isRunTrace(makeTrace())).toBe(true);
    expect(isRunTrace(null)).toBe(false);
    expect(isRunTrace({ runId: 'x' })).toBe(false);
    expect(isRunTrace({ ...makeTrace(), events: [{ nope: 1 }] })).toBe(false);
  });
});
