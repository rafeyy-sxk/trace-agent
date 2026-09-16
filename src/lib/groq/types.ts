export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly RawToolCall[];
  /** gpt-oss models return their chain of thought here. Display only. */
  readonly reasoning?: string;
}

export interface RawToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly unknown[];
  readonly toolChoice?: 'auto' | 'none' | 'required';
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface ChatResponse {
  readonly model: string;
  readonly content: string;
  readonly reasoning: string | null;
  readonly toolCalls: readonly RawToolCall[];
  readonly finishReason: string;
  readonly usage: TokenUsage;
  readonly latencyMs: number;
  /** `x-ratelimit-limit-tokens` from the response, when the provider sent it. */
  readonly tokenLimitPerMinute: number | null;
  readonly tokensRemaining: number | null;
}

/** The single seam every model call goes through. Mocked wholesale in tests. */
export type ChatFn = (request: ChatRequest) => Promise<ChatResponse>;

export class GroqError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Groq returned HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = 'GroqError';
    this.status = status;
    this.body = body;
  }
}

export class GroqRateLimitError extends GroqError {
  /** From `retry-after`, or parsed from the reset header, or a default. */
  readonly retryAfterMs: number;
  constructor(body: string, retryAfterMs: number) {
    super(429, body, `Groq rate limit hit; retry in ${retryAfterMs}ms`);
    this.name = 'GroqRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Groq validates tool names server-side and rejects a call to a name that is
 * not in `request.tools` with HTTP 400 and `code: "tool_use_failed"`.
 *
 * Observed live on 2026-09-16: the model emitted `"wiki..."` instead of
 * `"wikipedia"`. This is the model producing bad output, not the request being
 * malformed, so it is recoverable and must not end the run.
 */
export class GroqToolUseError extends GroqError {
  /** The raw generation the provider refused, when it told us. */
  readonly failedGeneration: string | null;

  constructor(body: string, failedGeneration: string | null, message: string) {
    super(400, body, `The provider rejected the model's tool call: ${message}`);
    this.name = 'GroqToolUseError';
    this.failedGeneration = failedGeneration;
  }
}

export class GroqAuthError extends GroqError {
  constructor(status: number, body: string) {
    super(status, body, 'Groq rejected the API key. Set a valid GROQ_API_KEY.');
    this.name = 'GroqAuthError';
  }
}
