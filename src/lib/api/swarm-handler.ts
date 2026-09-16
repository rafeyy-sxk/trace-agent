import { createGroqChat } from '../groq/client';
import { resolveModel } from '../groq/models';
import { GroqAuthError } from '../groq/types';
import { LIMITS, MissingApiKeyError, readApiKey, readModelOverride } from '../config';
import { NDJSON_CONTENT_TYPE, ndjsonStream } from '../stream';
import { TokenBudget } from '../swarm/budget';
import { planSubGoals } from '../swarm/planner';
import { runSwarm } from '../swarm/scheduler';
import type { SwarmEvent } from '../swarm/types';
import { ALL_TOOLS } from '../tools';
import type { AnyTool } from '../tools/types';
import { badRequest, serverError, swarmRequestSchema } from './schemas';

/** Emitted once, before the swarm starts, so the UI can say how the plan was made. */
export interface PlanSourceEvent {
  readonly type: 'plan_source';
  readonly at: number;
  readonly source: 'model' | 'fallback';
  readonly error?: string;
}

export interface SwarmHandlerDeps {
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly tools?: readonly AnyTool[];
}

/**
 * POST /api/swarm — plan, fan out, and stream every agent's trace.
 *
 * The planner call and the agent calls use two different chat clients on
 * purpose. The planner may absorb a 429 itself (nothing is waiting on it and
 * the run cannot start without it). The agent client must NOT, because the
 * scheduler needs to see the 429 to re-queue the agent and hold the gate.
 */
export async function handleSwarmRequest(
  request: Request,
  deps: SwarmHandlerDeps = {},
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest('invalid-json', 'The request body was not valid JSON.');
  }

  const parsed = swarmRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return badRequest(
      'invalid-request',
      'The request body did not match the expected shape.',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }

  let apiKey: string;
  try {
    apiKey = readApiKey(deps.env ?? process.env);
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return serverError('missing-api-key', error.message, 503);
    }
    throw error;
  }

  const fetchOptions = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  let model: string;
  try {
    const resolved = await resolveModel(apiKey, {
      ...fetchOptions,
      preferred: parsed.data.model ?? readModelOverride(deps.env ?? process.env),
    });
    model = resolved.id;
  } catch (error) {
    if (error instanceof GroqAuthError) {
      return serverError('invalid-api-key', 'Groq rejected the API key.', 401);
    }
    return serverError(
      'model-resolution-failed',
      error instanceof Error ? error.message : 'Could not resolve a model.',
      502,
    );
  }

  const controller = new AbortController();
  request.signal.addEventListener('abort', () => controller.abort(), { once: true });

  const plannerChat = createGroqChat({ apiKey, ...fetchOptions, maxRateLimitRetries: 2 });
  const agentChat = createGroqChat({ apiKey, ...fetchOptions, maxRateLimitRetries: 0 });

  const budget = new TokenBudget({
    limitPerMinute: parsed.data.tokenCeiling ?? LIMITS.fallbackTokensPerMinute,
  });

  const source = (async function* (): AsyncGenerator<SwarmEvent | PlanSourceEvent> {
    const plan = await planSubGoals({
      goal: parsed.data.goal,
      count: parsed.data.agents,
      model,
      chat: plannerChat,
      signal: controller.signal,
    });
    yield {
      type: 'plan_source',
      at: Date.now(),
      source: plan.source,
      ...(plan.error ? { error: plan.error } : {}),
    };
    yield* runSwarm({
      goal: parsed.data.goal,
      subGoals: plan.subGoals,
      model,
      chat: agentChat,
      budget,
      concurrency: Math.min(
        parsed.data.concurrency ?? LIMITS.swarmDefaultConcurrency,
        parsed.data.agents,
      ),
      maxStepsPerAgent: parsed.data.maxStepsPerAgent ?? LIMITS.swarmDefaultStepsPerAgent,
      ...(parsed.data.maxAttempts === undefined ? {} : { maxAttempts: parsed.data.maxAttempts }),
      ...(parsed.data.synthesize === undefined ? {} : { synthesize: parsed.data.synthesize }),
      tools: deps.tools ?? ALL_TOOLS,
      signal: controller.signal,
    });
  })();

  return new Response(
    ndjsonStream(source, { signal: controller.signal, onClose: () => controller.abort() }),
    {
      headers: {
        'content-type': NDJSON_CONTENT_TYPE,
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
        'x-trace-agent-model': model,
      },
    },
  );
}
