import type { ChatFn, ChatRequest, ChatResponse, RawToolCall } from '@/lib/groq/types';

export interface FakeTurn {
  readonly content?: string;
  readonly reasoning?: string;
  readonly toolCalls?: ReadonlyArray<{ name: string; args: unknown | string; id?: string }>;
  readonly finishReason?: string;
  readonly usage?: { prompt: number; completion: number };
  /** Throw this instead of answering. Used for 429 and failure paths. */
  readonly throws?: Error;
}

export function toRawToolCalls(turn: FakeTurn): RawToolCall[] {
  return (turn.toolCalls ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    type: 'function' as const,
    function: {
      name: call.name,
      arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
    },
  }));
}

export interface ScriptedChat {
  readonly fn: ChatFn;
  readonly requests: ChatRequest[];
  readonly callCount: () => number;
}

/**
 * A chat function that replays a fixed script.
 *
 * The last turn repeats once the script runs out, so a test that only cares
 * about the first two turns does not have to pad the script to the step budget.
 */
export function scriptedChat(turns: readonly FakeTurn[]): ScriptedChat {
  const requests: ChatRequest[] = [];
  let index = 0;
  const fn: ChatFn = async (request) => {
    requests.push(request);
    const turn = turns[Math.min(index, turns.length - 1)] ?? {};
    index += 1;
    if (turn.throws) throw turn.throws;
    return buildResponse(request, turn);
  };
  return { fn, requests, callCount: () => index };
}

export function buildResponse(request: ChatRequest, turn: FakeTurn): ChatResponse {
  const toolCalls = toRawToolCalls(turn);
  const prompt = turn.usage?.prompt ?? 120;
  const completion = turn.usage?.completion ?? 40;
  return {
    model: request.model,
    content: turn.content ?? '',
    reasoning: turn.reasoning ?? null,
    toolCalls,
    finishReason: turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion },
    latencyMs: 5,
    tokenLimitPerMinute: null,
    tokensRemaining: null,
  };
}

/** A fetch stub that answers from a routing table keyed by URL substring. */
export function routedFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const [fragment, make] of Object.entries(routes)) {
      if (url.includes(fragment)) return make();
    }
    throw new Error(`No route registered for ${url}`);
  }) as typeof fetch;
}

export const MODELS_RESPONSE = {
  object: 'list',
  data: [
    { id: 'whisper-large-v3', context_window: 448, owned_by: 'OpenAI', active: true },
    { id: 'openai/gpt-oss-120b', context_window: 131072, owned_by: 'OpenAI', active: true },
    { id: 'openai/gpt-oss-20b', context_window: 131072, owned_by: 'OpenAI', active: true },
    { id: 'meta-llama/llama-prompt-guard-2-22m', context_window: 512, owned_by: 'Meta', active: true },
  ],
};
