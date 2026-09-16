/**
 * Runtime configuration.
 *
 * Exactly two env vars are read. `GROQ_BASE_URL` is deliberately NOT one of
 * them: the provider URL is a source constant (`groq/endpoint.ts`) so that
 * nothing outside a code review can redirect an authenticated request.
 */

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'GROQ_API_KEY is not set. Create a free key at https://console.groq.com/keys ' +
        'and put it in .env.local as GROQ_API_KEY=...',
    );
    this.name = 'MissingApiKeyError';
  }
}

export function readApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.GROQ_API_KEY?.trim();
  if (!key) throw new MissingApiKeyError();
  return key;
}

export function hasApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GROQ_API_KEY?.trim());
}

/** Optional pin. Still validated against the live model list before use. */
export function readModelOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.TRACE_AGENT_MODEL?.trim();
  return value && value.length > 0 ? value : undefined;
}

export const LIMITS = {
  goalMaxChars: 2_000,
  singleRunMaxSteps: 10,
  singleRunDefaultSteps: 6,
  swarmMaxAgents: 100,
  swarmDefaultAgents: 12,
  swarmMaxConcurrency: 100,
  swarmDefaultConcurrency: 8,
  swarmMaxStepsPerAgent: 5,
  swarmDefaultStepsPerAgent: 3,
  /**
   * Fallback ceiling used only until the first live response tells us the real
   * one via `x-ratelimit-limit-tokens`. Groq's free tier is 8,000 tokens/min.
   */
  fallbackTokensPerMinute: 8_000,
} as const;
