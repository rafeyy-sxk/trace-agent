import { handleSwarmRequest } from '@/lib/api/swarm-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return handleSwarmRequest(request);
}
