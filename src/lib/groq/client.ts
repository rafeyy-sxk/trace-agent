import { GROQ_CHAT_COMPLETIONS_URL } from './endpoint';
import {
  GroqAuthError,
  GroqError,
  GroqRateLimitError,
  GroqToolUseError,
  type ChatFn,
  type ChatRequest,
  type ChatResponse,
  type RawToolCall,
} from './types';

/**
 * Parse Groq's duration strings: `2m52.8s`, `952ms`, `1.5s`, `13s`.
 * Returns milliseconds, or null when the header is absent or unparseable.
 */
export function parseDurationHeader(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  // `retry-after` may be a bare number of seconds.
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);

  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(trimmed)) !== null) {
    matched = true;
    const amount = Number(match[1]);
    switch (match[2]) {
      case 'ms':
        total += amount;
        break;
      case 's':
        total += amount * 1000;
        break;
      case 'm':
        total += amount * 60_000;
        break;
      case 'h':
        total += amount * 3_600_000;
        break;
      default:
        break;
    }
  }
  return matched ? Math.round(total) : null;
}

const DEFAULT_RETRY_AFTER_MS = 5_000;
const MAX_RETRY_AFTER_MS = 120_000;

/** How long to hold off after a 429, honouring the provider's own numbers. */
export function retryAfterFrom(headers: Headers): number {
  const explicit = parseDurationHeader(headers.get('retry-after'));
  const resetTokens = parseDurationHeader(headers.get('x-ratelimit-reset-tokens'));
  const resetRequests = parseDurationHeader(headers.get('x-ratelimit-reset-requests'));
  const candidates = [explicit, resetTokens, resetRequests].filter(
    (value): value is number => value !== null && value >= 0,
  );
  const chosen = candidates.length > 0 ? Math.max(...candidates) : DEFAULT_RETRY_AFTER_MS;
  // Add a small margin: resetting exactly at the boundary races the provider.
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(250, Math.round(chosen * 1.1) + 150));
}

interface ToolUseFailure {
  readonly message: string;
  readonly failedGeneration: string | null;
}

/** Recognise Groq's `tool_use_failed` shape inside a 400 body. */
export function readToolUseFailure(body: string): ToolUseFailure | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string; failed_generation?: string };
    };
    if (parsed.error?.code !== 'tool_use_failed') return null;
    return {
      message: parsed.error.message ?? 'the model called a tool that was not offered',
      failedGeneration: parsed.error.failed_generation ?? null,
    };
  } catch {
    return null;
  }
}

function readIntHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

interface CompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function normalizeToolCalls(raw: CompletionResponse['choices']): RawToolCall[] {
  const calls = raw?.[0]?.message?.tool_calls ?? [];
  return calls
    .filter((call) => typeof call.function?.name === 'string')
    .map((call, index) => ({
      id: call.id ?? `call_${index}`,
      type: 'function' as const,
      function: {
        name: call.function?.name as string,
        arguments: call.function?.arguments ?? '{}',
      },
    }));
}

export interface GroqClientOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * How many times to absorb a 429 inside the client. Single-agent runs set
   * this to 3. Swarm runs set it to 0 so the scheduler owns retry policy and
   * can re-queue the whole agent instead of blocking a worker slot.
   */
  readonly maxRateLimitRetries?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  /**
   * Called before the client sleeps off a 429. Without this the agent stalls
   * for minutes and the trace shows nothing at all, which is the opposite of
   * what this app claims to do.
   */
  readonly onRateLimit?: (info: { attempt: number; waitMs: number }) => void;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Build the single function every model call goes through.
 *
 * The URL is a hardcoded constant (see `endpoint.ts`). The only injectable
 * seam is `fetchImpl`, which exists for tests and never reads an env var.
 */
export function createGroqChat(options: GroqClientOptions): ChatFn {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const maxRetries = options.maxRateLimitRetries ?? 3;

  return async function chat(request: ChatRequest): Promise<ChatResponse> {
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 1024,
    };
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools;
      payload.tool_choice = request.toolChoice ?? 'auto';
    }
    const serialized = JSON.stringify(payload);

    for (let attempt = 0; ; attempt += 1) {
      const startedAt = now();
      const response = await doFetch(GROQ_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: serialized,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const latencyMs = now() - startedAt;
      const body = await response.text();

      if (response.status === 429) {
        const retryAfterMs = retryAfterFrom(response.headers);
        if (attempt >= maxRetries) throw new GroqRateLimitError(body, retryAfterMs);
        // Exponential on top of the provider's own number, never below it.
        const waitMs = retryAfterMs * 2 ** attempt;
        options.onRateLimit?.({ attempt: attempt + 1, waitMs });
        await sleep(waitMs, request.signal);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new GroqAuthError(response.status, body);
      }
      if (response.status >= 500 && attempt < maxRetries) {
        await sleep(500 * 2 ** attempt, request.signal);
        continue;
      }
      if (response.status === 400) {
        const failure = readToolUseFailure(body);
        if (failure) {
          throw new GroqToolUseError(body, failure.failedGeneration, failure.message);
        }
      }
      if (!response.ok) {
        throw new GroqError(response.status, body);
      }

      let parsed: CompletionResponse;
      try {
        parsed = JSON.parse(body) as CompletionResponse;
      } catch {
        throw new GroqError(response.status, body, 'Groq returned a non-JSON completion');
      }

      const choice = parsed.choices?.[0];
      if (!choice) {
        throw new GroqError(response.status, body, 'Groq returned no choices');
      }

      const usage = parsed.usage ?? {};
      return {
        model: parsed.model ?? request.model,
        content: choice.message?.content ?? '',
        reasoning: choice.message?.reasoning ?? null,
        toolCalls: normalizeToolCalls(parsed.choices),
        finishReason: choice.finish_reason ?? 'unknown',
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens:
            usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
        },
        latencyMs,
        tokenLimitPerMinute: readIntHeader(response.headers, 'x-ratelimit-limit-tokens'),
        tokensRemaining: readIntHeader(response.headers, 'x-ratelimit-remaining-tokens'),
      };
    }
  };
}
