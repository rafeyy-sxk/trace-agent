import { GROQ_MODELS_URL } from './endpoint';
import { GroqAuthError, GroqError } from './types';

/**
 * Model selection at runtime, not at authoring time.
 *
 * Groq retires models on weeks of notice. A hardcoded id is a time bomb that
 * goes off in production long after the commit that planted it, so the app
 * asks the provider what exists and picks from what it gets back.
 */

export interface GroqModel {
  readonly id: string;
  readonly contextWindow: number;
  readonly ownedBy: string;
  readonly active: boolean;
}

interface ModelsResponse {
  data?: Array<{
    id?: string;
    context_window?: number;
    owned_by?: string;
    active?: boolean;
  }>;
}

/**
 * Models that are live but cannot serve a tool-using chat turn: speech,
 * text-to-speech and the prompt-injection classifiers. Matched by substring
 * so a new `whisper-*` revision is excluded without a code change.
 */
const NON_CHAT_PATTERNS = [
  'whisper',
  'orpheus',
  'prompt-guard',
  'tts',
  'guard',
  'embed',
  'rerank',
] as const;

/**
 * Preference order, most capable first. Matched as a prefix, so
 * `openai/gpt-oss-120b` still matches after a version suffix is appended.
 * If none match we fall back to the widest context window on offer, which is
 * the sane default for an agent that pastes web pages into its context.
 */
const PREFERRED_PREFIXES = [
  'openai/gpt-oss-120b',
  'qwen/qwen3',
  'openai/gpt-oss-20b',
  'llama-3.3-70b',
  'llama-3.1-8b',
  'groq/compound',
] as const;

const MIN_USEFUL_CONTEXT = 8_192;

export function isChatCapable(model: GroqModel): boolean {
  if (!model.active) return false;
  if (model.contextWindow < MIN_USEFUL_CONTEXT) return false;
  const id = model.id.toLowerCase();
  return !NON_CHAT_PATTERNS.some((pattern) => id.includes(pattern));
}

/** Rank the chat-capable models. Index 0 is the one the app will use. */
export function rankModels(models: readonly GroqModel[]): GroqModel[] {
  const candidates = models.filter(isChatCapable);
  const scoreOf = (model: GroqModel): number => {
    const index = PREFERRED_PREFIXES.findIndex((prefix) => model.id.startsWith(prefix));
    return index === -1 ? PREFERRED_PREFIXES.length : index;
  };
  return [...candidates].sort((a, b) => {
    const delta = scoreOf(a) - scoreOf(b);
    if (delta !== 0) return delta;
    if (b.contextWindow !== a.contextWindow) return b.contextWindow - a.contextWindow;
    return a.id.localeCompare(b.id);
  });
}

export class NoUsableModelError extends Error {
  constructor(seen: readonly string[]) {
    super(
      seen.length === 0
        ? 'Groq returned no models at all.'
        : `None of the ${seen.length} models Groq returned can serve a tool-using chat turn. Saw: ${seen.join(', ')}`,
    );
    this.name = 'NoUsableModelError';
  }
}

export async function fetchModels(
  apiKey: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GroqModel[]> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const response = await doFetch(GROQ_MODELS_URL, {
    headers: { authorization: `Bearer ${apiKey}` },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new GroqAuthError(response.status, body);
  }
  if (!response.ok) {
    throw new GroqError(response.status, body);
  }
  let parsed: ModelsResponse;
  try {
    parsed = JSON.parse(body) as ModelsResponse;
  } catch {
    throw new GroqError(response.status, body, 'Groq returned a non-JSON model list');
  }
  return (parsed.data ?? [])
    .filter((entry): entry is { id: string } & typeof entry => typeof entry.id === 'string')
    .map((entry) => ({
      id: entry.id,
      contextWindow: entry.context_window ?? 0,
      ownedBy: entry.owned_by ?? 'unknown',
      active: entry.active !== false,
    }));
}

interface CacheEntry {
  readonly models: GroqModel[];
  readonly fetchedAt: number;
}

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
let cache: CacheEntry | null = null;

/** Exposed so tests start from a clean slate. */
export function clearModelCache(): void {
  cache = null;
}

export interface ResolveModelOptions {
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /** Explicit override. Used verbatim, but still checked against the live list. */
  readonly preferred?: string | undefined;
}

export interface ResolvedModel {
  readonly id: string;
  readonly contextWindow: number;
  readonly alternatives: readonly string[];
  readonly source: 'override' | 'ranked';
  /** True when the list came from the in-process cache rather than the API. */
  readonly cached: boolean;
}

/**
 * Resolve the model to use. Caches the list in module memory for ten minutes —
 * no filesystem, so this is safe on a read-only serverless filesystem.
 */
export async function resolveModel(
  apiKey: string,
  options: ResolveModelOptions = {},
): Promise<ResolvedModel> {
  const now = options.now ?? Date.now;
  let cached = true;
  if (!cache || now() - cache.fetchedAt > MODEL_CACHE_TTL_MS) {
    const fetchOptions: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {};
    if (options.fetchImpl) fetchOptions.fetchImpl = options.fetchImpl;
    if (options.signal) fetchOptions.signal = options.signal;
    cache = { models: await fetchModels(apiKey, fetchOptions), fetchedAt: now() };
    cached = false;
  }

  const ranked = rankModels(cache.models);
  const alternatives = ranked.map((model) => model.id);

  if (options.preferred) {
    const match = cache.models.find((model) => model.id === options.preferred);
    if (match) {
      return {
        id: match.id,
        contextWindow: match.contextWindow,
        alternatives,
        source: 'override',
        cached,
      };
    }
    throw new NoUsableModelError(cache.models.map((model) => model.id));
  }

  const best = ranked[0];
  if (!best) throw new NoUsableModelError(cache.models.map((model) => model.id));
  return {
    id: best.id,
    contextWindow: best.contextWindow,
    alternatives,
    source: 'ranked',
    cached,
  };
}
