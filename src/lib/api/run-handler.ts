import { runAgent } from '../agent/loop';
import { NoticeSink } from '../agent/notices';
import { createGroqChat } from '../groq/client';
import { resolveModel } from '../groq/models';
import { GroqAuthError } from '../groq/types';
import { MissingApiKeyError, readApiKey, readModelOverride, LIMITS } from '../config';
import { NDJSON_CONTENT_TYPE, ndjsonStream } from '../stream';
import { ALL_TOOLS } from '../tools';
import type { AnyTool } from '../tools/types';
import { badRequest, runRequestSchema, serverError } from './schemas';

export interface RunHandlerDeps {
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly tools?: readonly AnyTool[];
}

function selectTools(names: readonly string[] | undefined, available: readonly AnyTool[]): AnyTool[] | null {
  if (!names) return [...available];
  const byName = new Map(available.map((tool) => [tool.name, tool]));
  const selected: AnyTool[] = [];
  for (const name of names) {
    const tool = byName.get(name);
    if (!tool) return null;
    selected.push(tool);
  }
  return selected;
}

/**
 * POST /api/run — stream one agent run as NDJSON.
 *
 * Every dependency that touches the network is injected, so the whole handler
 * runs in a test with a mocked `fetch` and no key.
 */
export async function handleRunRequest(
  request: Request,
  deps: RunHandlerDeps = {},
): Promise<Response> {
  const available = deps.tools ?? ALL_TOOLS;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest('invalid-json', 'The request body was not valid JSON.');
  }

  const parsed = runRequestSchema.safeParse(payload);
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

  const tools = selectTools(parsed.data.tools, available);
  if (!tools) {
    return badRequest(
      'unknown-tool',
      `Unknown tool requested. Available: ${available.map((tool) => tool.name).join(', ')}.`,
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

  const notices = new NoticeSink();
  const chat = createGroqChat({
    apiKey,
    ...fetchOptions,
    maxRateLimitRetries: 3,
    onRateLimit: ({ attempt, waitMs }) =>
      notices.push({
        level: 'warn',
        code: 'rate-limited-backoff',
        message:
          `Groq rate limit reached (attempt ${attempt}). Waiting ${Math.round(waitMs / 1000)}s ` +
          'before retrying, honouring the retry-after the provider sent.',
      }),
  });

  const stream = ndjsonStream(
    runAgent({
      goal: parsed.data.goal,
      model,
      chat,
      tools,
      maxSteps: parsed.data.maxSteps ?? LIMITS.singleRunDefaultSteps,
      notices,
      ...(parsed.data.temperature === undefined ? {} : { temperature: parsed.data.temperature }),
      signal: controller.signal,
    }),
    { signal: controller.signal, onClose: () => controller.abort() },
  );

  return new Response(stream, {
    headers: {
      'content-type': NDJSON_CONTENT_TYPE,
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      'x-trace-agent-model': model,
    },
  });
}
