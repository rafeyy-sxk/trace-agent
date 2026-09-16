import { hasApiKey, readModelOverride } from '@/lib/config';
import { readApiKey } from '@/lib/config';
import { resolveModel } from '@/lib/groq/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/models — what the app will actually use, resolved live. */
export async function GET(): Promise<Response> {
  if (!hasApiKey()) {
    return Response.json(
      { error: 'GROQ_API_KEY is not set on the server.', code: 'missing-api-key' },
      { status: 503 },
    );
  }
  try {
    const resolved = await resolveModel(readApiKey(), { preferred: readModelOverride() });
    return Response.json(
      {
        model: resolved.id,
        contextWindow: resolved.contextWindow,
        source: resolved.source,
        cached: resolved.cached,
        alternatives: resolved.alternatives,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Could not resolve a model.',
        code: 'model-resolution-failed',
      },
      { status: 502 },
    );
  }
}
