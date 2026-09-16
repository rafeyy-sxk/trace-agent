import { handleRunRequest } from '@/lib/api/run-handler';

/**
 * Node runtime, not edge: the SSRF guard resolves hostnames with
 * `node:dns/promises` before any outbound request, which the edge runtime
 * cannot do. A guard that silently degrades is not a guard.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return handleRunRequest(request);
}
