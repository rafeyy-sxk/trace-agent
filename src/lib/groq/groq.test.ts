import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS_RESPONSE } from '@/test/mocks';
import { createGroqChat, parseDurationHeader, retryAfterFrom } from './client';
import { GROQ_CHAT_COMPLETIONS_URL, GROQ_MODELS_URL } from './endpoint';
import {
  clearModelCache,
  isChatCapable,
  NoUsableModelError,
  rankModels,
  resolveModel,
} from './models';
import { GroqAuthError, GroqError, GroqRateLimitError } from './types';

const COMPLETION = {
  model: 'openai/gpt-oss-120b',
  choices: [
    {
      message: { content: 'hello', reasoning: 'thinking', tool_calls: [] },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

function ok(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('provider endpoint', () => {
  it('should be a hardcoded https URL that no env var can move', () => {
    expect(GROQ_CHAT_COMPLETIONS_URL).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(GROQ_MODELS_URL).toBe('https://api.groq.com/openai/v1/models');
  });

  it('should send requests to that exact URL', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok(COMPLETION));
    const chat = createGroqChat({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    await chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(GROQ_CHAT_COMPLETIONS_URL);
  });

  it('should ignore GROQ_BASE_URL even when it is set in the environment', async () => {
    const previous = process.env.GROQ_BASE_URL;
    process.env.GROQ_BASE_URL = 'https://attacker.example.com/v1';
    try {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok(COMPLETION));
      const chat = createGroqChat({
        apiKey: 'test-key',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(GROQ_CHAT_COMPLETIONS_URL);
      expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('attacker');
    } finally {
      if (previous === undefined) delete process.env.GROQ_BASE_URL;
      else process.env.GROQ_BASE_URL = previous;
    }
  });
});

describe('retry-after parsing', () => {
  it.each([
    ['2m52.8s', 172_800],
    ['952ms', 952],
    ['13s', 13_000],
    ['1.5s', 1_500],
    ['30', 30_000],
  ])('should parse %s as %ims', (input, expected) => {
    expect(parseDurationHeader(input)).toBe(expected);
  });

  it('should return null for a header that is absent or unparseable', () => {
    expect(parseDurationHeader(null)).toBeNull();
    expect(parseDurationHeader('soon')).toBeNull();
  });

  it('should take the longest of the reset headers and add a margin', () => {
    const headers = new Headers({
      'x-ratelimit-reset-tokens': '1s',
      'x-ratelimit-reset-requests': '4s',
    });
    const wait = retryAfterFrom(headers);
    expect(wait).toBeGreaterThanOrEqual(4_000);
    expect(wait).toBeLessThan(6_000);
  });

  it('should fall back to a default when no header says anything', () => {
    expect(retryAfterFrom(new Headers())).toBeGreaterThan(1_000);
  });
});

describe('createGroqChat', () => {
  it('should normalise a completion including the reasoning field and usage', async () => {
    const fetchImpl = vi.fn(async () => ok(COMPLETION, { 'x-ratelimit-limit-tokens': '8000' }));
    const chat = createGroqChat({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

    expect(response.content).toBe('hello');
    expect(response.reasoning).toBe('thinking');
    expect(response.usage.totalTokens).toBe(15);
    expect(response.tokenLimitPerMinute).toBe(8000);
    expect(response.finishReason).toBe('stop');
  });

  it('should retry a 429 honouring retry-after and then succeed', async () => {
    const sleeps: number[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response('{"error":"rate limited"}', {
          status: 429,
          headers: { 'retry-after': '2' },
        });
      }
      return ok(COMPLETION);
    });
    const chat = createGroqChat({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const response = await chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('hello');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2_000);
  });

  it('should back off exponentially on top of retry-after across attempts', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '1' } }),
    );
    const chat = createGroqChat({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRateLimitRetries: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(chat({ model: 'm', messages: [] })).rejects.toBeInstanceOf(GroqRateLimitError);
    expect(sleeps).toHaveLength(3);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] as number);
    expect(sleeps[2]).toBeGreaterThan(sleeps[1] as number);
  });

  it('should throw a rate-limit error immediately when retries are disabled', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '3' } }),
    );
    const chat = createGroqChat({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRateLimitRetries: 0,
    });
    const error = await chat({ model: 'm', messages: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GroqRateLimitError);
    expect((error as GroqRateLimitError).retryAfterMs).toBeGreaterThanOrEqual(3_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('should never retry an auth failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"bad key"}', { status: 401 }));
    const chat = createGroqChat({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(chat({ model: 'm', messages: [] })).rejects.toBeInstanceOf(GroqAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('should raise a clear error when the provider returns a non-JSON body', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 200 }));
    const chat = createGroqChat({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(chat({ model: 'm', messages: [] })).rejects.toBeInstanceOf(GroqError);
  });

  it('should only send the tools field when tools were supplied', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return ok(COMPLETION);
    });
    const chat = createGroqChat({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await chat({ model: 'm', messages: [] });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});

describe('live model discovery', () => {
  beforeEach(() => clearModelCache());

  it('should exclude speech and guard models from chat selection', () => {
    expect(isChatCapable({ id: 'whisper-large-v3', contextWindow: 448, ownedBy: 'x', active: true })).toBe(false);
    expect(
      isChatCapable({ id: 'meta-llama/llama-prompt-guard-2-22m', contextWindow: 512, ownedBy: 'x', active: true }),
    ).toBe(false);
    expect(
      isChatCapable({ id: 'openai/gpt-oss-120b', contextWindow: 131072, ownedBy: 'x', active: true }),
    ).toBe(true);
  });

  it('should exclude a model the provider marked inactive', () => {
    expect(
      isChatCapable({ id: 'openai/gpt-oss-120b', contextWindow: 131072, ownedBy: 'x', active: false }),
    ).toBe(false);
  });

  it('should rank by preference first and context window second', () => {
    const ranked = rankModels([
      { id: 'some-other-model', contextWindow: 200_000, ownedBy: 'x', active: true },
      { id: 'openai/gpt-oss-20b', contextWindow: 131_072, ownedBy: 'x', active: true },
      { id: 'openai/gpt-oss-120b', contextWindow: 131_072, ownedBy: 'x', active: true },
    ]);
    expect(ranked[0]?.id).toBe('openai/gpt-oss-120b');
    expect(ranked[1]?.id).toBe('openai/gpt-oss-20b');
    expect(ranked[2]?.id).toBe('some-other-model');
  });

  it('should resolve a model from the live list rather than a hardcoded id', async () => {
    const fetchImpl = vi.fn(async () => ok(MODELS_RESPONSE));
    const resolved = await resolveModel('k', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(resolved.id).toBe('openai/gpt-oss-120b');
    expect(resolved.source).toBe('ranked');
    expect(resolved.alternatives).toContain('openai/gpt-oss-20b');
    expect(resolved.alternatives).not.toContain('whisper-large-v3');
  });

  it('should honour an explicit override that exists in the live list', async () => {
    const fetchImpl = vi.fn(async () => ok(MODELS_RESPONSE));
    const resolved = await resolveModel('k', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      preferred: 'openai/gpt-oss-20b',
    });
    expect(resolved.id).toBe('openai/gpt-oss-20b');
    expect(resolved.source).toBe('override');
  });

  it('should refuse an override the provider no longer serves instead of failing at call time', async () => {
    const fetchImpl = vi.fn(async () => ok(MODELS_RESPONSE));
    await expect(
      resolveModel('k', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        preferred: 'llama-3.1-70b-versatile-retired',
      }),
    ).rejects.toBeInstanceOf(NoUsableModelError);
  });

  it('should raise a named error when nothing in the live list can chat', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ data: [{ id: 'whisper-large-v3', context_window: 448, active: true }] }),
    );
    await expect(
      resolveModel('k', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(NoUsableModelError);
  });

  it('should cache the list in memory and not refetch within the TTL', async () => {
    const fetchImpl = vi.fn(async () => ok(MODELS_RESPONSE));
    const first = await resolveModel('k', { fetchImpl: fetchImpl as unknown as typeof fetch });
    const second = await resolveModel('k', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });
});
