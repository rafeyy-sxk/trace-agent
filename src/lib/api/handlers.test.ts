import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS_RESPONSE, routedFetch } from '@/test/mocks';
import type { TraceEvent } from '../agent/types';
import { clearModelCache } from '../groq/models';
import { parseNdjson } from '../stream';
import { calculatorTool } from '../tools';
import type { AnyTool } from '../tools/types';
import { handleRunRequest } from './run-handler';
import { handleSwarmRequest } from './swarm-handler';

const TOOLS = [calculatorTool] as unknown as readonly AnyTool[];
const ENV = { GROQ_API_KEY: 'test-key' } as unknown as NodeJS.ProcessEnv;

function post(body: unknown, url = 'https://app.test/api/run'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function badPost(raw: string): Request {
  return new Request('https://app.test/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
}

function completion(content: string, toolCalls: unknown[] = []): Response {
  return new Response(
    JSON.stringify({
      model: 'openai/gpt-oss-120b',
      choices: [
        {
          message: { content, reasoning: 'deliberating', tool_calls: toolCalls },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function collect<T>(response: Response): Promise<T[]> {
  const out: T[] = [];
  if (!response.body) return out;
  for await (const event of parseNdjson<T>(response.body)) out.push(event);
  return out;
}

describe('POST /api/run', () => {
  beforeEach(() => clearModelCache());

  it('should stream a complete NDJSON trace for a valid request', async () => {
    let call = 0;
    const fetchImpl = routedFetch({
      '/v1/models': () => new Response(JSON.stringify(MODELS_RESPONSE), { status: 200 }),
      '/v1/chat/completions': () => {
        call += 1;
        return call === 1
          ? completion('', [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'calculator', arguments: '{"expression":"6*7"}' },
              },
            ])
          : completion('The answer is 42.');
      },
    });

    const response = await handleRunRequest(post({ goal: 'what is six times seven' }), {
      fetchImpl,
      env: ENV,
      tools: TOOLS,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(response.headers.get('x-trace-agent-model')).toBe('openai/gpt-oss-120b');

    const events = await collect<TraceEvent>(response);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run_started');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('final_answer');
    expect(types.at(-1)).toBe('run_finished');

    const finished = events.at(-1);
    expect(finished?.type === 'run_finished' && finished.status).toBe('completed');
    expect(finished?.type === 'run_finished' && finished.usage.totalTokens).toBe(200);
  });

  it('should reject a body that is not JSON', async () => {
    const response = await handleRunRequest(badPost('{not json'), { env: ENV, tools: TOOLS });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('invalid-json');
  });

  it('should reject a goal that is too short', async () => {
    const response = await handleRunRequest(post({ goal: 'hi' }), { env: ENV, tools: TOOLS });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; detail: unknown[] };
    expect(body.code).toBe('invalid-request');
    expect(body.detail.length).toBeGreaterThan(0);
  });

  it('should reject a step budget above the hard ceiling', async () => {
    const response = await handleRunRequest(post({ goal: 'a real goal', maxSteps: 999 }), {
      env: ENV,
      tools: TOOLS,
    });
    expect(response.status).toBe(400);
  });

  it('should reject a tool name it does not have', async () => {
    const response = await handleRunRequest(post({ goal: 'a real goal', tools: ['rm_rf'] }), {
      env: ENV,
      tools: TOOLS,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('unknown-tool');
  });

  it('should return 503 with an actionable message when no key is configured', async () => {
    const response = await handleRunRequest(post({ goal: 'a real goal' }), {
      env: {} as NodeJS.ProcessEnv,
      tools: TOOLS,
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe('missing-api-key');
    expect(body.error).toContain('console.groq.com');
  });

  it('should return 401 when the provider rejects the key', async () => {
    const fetchImpl = routedFetch({
      '/v1/models': () => new Response('{"error":"invalid key"}', { status: 401 }),
    });
    const response = await handleRunRequest(post({ goal: 'a real goal' }), {
      fetchImpl,
      env: ENV,
      tools: TOOLS,
    });
    expect(response.status).toBe(401);
  });

  it('should never send the API key to anything but the Groq host', async () => {
    const seen: string[] = [];
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const auth = new Headers(init?.headers).get('authorization');
      if (auth) seen.push(url);
      return Promise.resolve(
        url.includes('/models')
          ? new Response(JSON.stringify(MODELS_RESPONSE), { status: 200 })
          : completion('done'),
      );
    }) as typeof fetch;

    const response = await handleRunRequest(post({ goal: 'a real goal' }), {
      fetchImpl,
      env: ENV,
      tools: TOOLS,
    });
    await collect(response);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((url) => url.startsWith('https://api.groq.com/'))).toBe(true);
  });

  it('should surface a tool refusal inside the trace rather than failing the request', async () => {
    let call = 0;
    const fetchImpl = routedFetch({
      '/v1/models': () => new Response(JSON.stringify(MODELS_RESPONSE), { status: 200 }),
      '/v1/chat/completions': () => {
        call += 1;
        return call === 1
          ? completion('', [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'calculator', arguments: '{"expression":"1/0"}' },
              },
            ])
          : completion('That is undefined.');
      },
    });
    const response = await handleRunRequest(post({ goal: 'divide one by zero' }), {
      fetchImpl,
      env: ENV,
      tools: TOOLS,
    });
    expect(response.status).toBe(200);
    const events = await collect<TraceEvent>(response);
    const result = events.find((event) => event.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.ok).toBe(false);
  });
});

describe('POST /api/swarm', () => {
  beforeEach(() => clearModelCache());

  it('should plan, fan out and stream every agent trace plus a final report', async () => {
    let call = 0;
    const fetchImpl = routedFetch({
      '/v1/models': () => new Response(JSON.stringify(MODELS_RESPONSE), { status: 200 }),
      '/v1/chat/completions': () => {
        call += 1;
        if (call === 1) {
          return completion(
            JSON.stringify({
              subgoals: [
                { title: 'A', goal: 'Research the first angle thoroughly.' },
                { title: 'B', goal: 'Research the second angle thoroughly.' },
              ],
            }),
          );
        }
        return completion(`finding number ${call}`);
      },
    });

    const response = await handleSwarmRequest(
      post({ goal: 'brief me on fusion', agents: 2, concurrency: 2, synthesize: false }, 'https://app.test/api/swarm'),
      { fetchImpl, env: ENV, tools: TOOLS },
    );

    expect(response.status).toBe(200);
    const events = await collect<{ type: string }>(response);
    const types = events.map((event) => event.type);
    expect(types).toContain('plan_source');
    expect(types).toContain('swarm_started');
    expect(types).toContain('plan_ready');
    expect(types).toContain('agent_event');
    expect(types).toContain('merged_answer');
    expect(types.at(-1)).toBe('swarm_finished');

    const finished = events.at(-1) as unknown as {
      report: { ledger: { completed: number; failed: number } };
    };
    expect(finished.report.ledger.completed).toBe(2);
    expect(finished.report.ledger.failed).toBe(0);
  });

  it('should reject a swarm larger than the hard agent ceiling', async () => {
    const response = await handleSwarmRequest(
      post({ goal: 'brief me', agents: 500 }, 'https://app.test/api/swarm'),
      { env: ENV, tools: TOOLS },
    );
    expect(response.status).toBe(400);
  });

  it('should require an agent count', async () => {
    const response = await handleSwarmRequest(
      post({ goal: 'brief me' }, 'https://app.test/api/swarm'),
      { env: ENV, tools: TOOLS },
    );
    expect(response.status).toBe(400);
  });

  it('should return 503 when no key is configured', async () => {
    const response = await handleSwarmRequest(
      post({ goal: 'brief me', agents: 2 }, 'https://app.test/api/swarm'),
      { env: {} as NodeJS.ProcessEnv, tools: TOOLS },
    );
    expect(response.status).toBe(503);
  });

  it('should still finish and report failures when every agent call errors', async () => {
    const fetchImpl = routedFetch({
      '/v1/models': () => new Response(JSON.stringify(MODELS_RESPONSE), { status: 200 }),
      '/v1/chat/completions': () => new Response('{"error":"upstream down"}', { status: 500 }),
    });
    const response = await handleSwarmRequest(
      post({ goal: 'brief me', agents: 2, concurrency: 2, maxAttempts: 1 }, 'https://app.test/api/swarm'),
      { fetchImpl, env: ENV, tools: TOOLS },
    );
    const events = await collect<{ type: string }>(response);
    const finished = events.at(-1) as unknown as {
      type: string;
      report: { ledger: { failed: number; completed: number } };
    };
    expect(finished.type).toBe('swarm_finished');
    expect(finished.report.ledger.failed).toBe(2);
    expect(finished.report.ledger.completed).toBe(0);
  }, 30_000);
});

describe('NDJSON stream framing', () => {
  it('should reassemble objects split across chunk boundaries', async () => {
    const line = `${JSON.stringify({ type: 'a', value: 1 })}\n${JSON.stringify({ type: 'b', value: 2 })}\n`;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(line);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-object on purpose.
        controller.enqueue(bytes.slice(0, 12));
        controller.enqueue(bytes.slice(12, 30));
        controller.enqueue(bytes.slice(30));
        controller.close();
      },
    });
    const out: unknown[] = [];
    for await (const value of parseNdjson(stream)) out.push(value);
    expect(out).toEqual([
      { type: 'a', value: 1 },
      { type: 'b', value: 2 },
    ]);
  });

  it('should survive a truncated final line instead of throwing', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"a"}\n{"type":"b'));
        controller.close();
      },
    });
    const out: unknown[] = [];
    for await (const value of parseNdjson(stream)) out.push(value);
    expect(out).toEqual([{ type: 'a' }]);
  });
});

describe('the no-network guard', () => {
  it('should make an accidental real fetch fail loudly', () => {
    expect(() => void globalThis.fetch('https://example.com')).toThrow(/tried to reach the network/);
    expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
  });
});

describe('rate limit visibility', () => {
  beforeEach(() => clearModelCache());

  it('should emit a notice into the trace when the client backs off on a 429', async () => {
    // Live run 2026-09-16: the client absorbed a 429 and slept 122 seconds.
    // The trace showed nothing for those two minutes.
    let chatCalls = 0;
    const fetchImpl = routedFetch({
      '/v1/models': () => new Response(JSON.stringify(MODELS_RESPONSE), { status: 200 }),
      '/v1/chat/completions': () => {
        chatCalls += 1;
        if (chatCalls === 1) {
          return new Response('{"error":"rate limit"}', {
            status: 429,
            headers: { 'retry-after': '0.01' },
          });
        }
        return completion('Answered after the backoff.');
      },
    });

    const response = await handleRunRequest(post({ goal: 'a goal that gets rate limited' }), {
      fetchImpl,
      env: ENV,
      tools: TOOLS,
    });
    const events = await collect<TraceEvent>(response);

    const notice = events.find(
      (event) => event.type === 'notice' && event.code === 'rate-limited-backoff',
    );
    expect(notice).toBeDefined();
    expect(notice?.type === 'notice' && notice.message).toContain('retry-after');
    const finished = events.at(-1);
    expect(finished?.type === 'run_finished' && finished.status).toBe('completed');
  });
});
