import { z } from 'zod/v4';
import { LIMITS } from '../config';

export const runRequestSchema = z.object({
  goal: z.string().trim().min(3).max(LIMITS.goalMaxChars),
  maxSteps: z.number().int().min(1).max(LIMITS.singleRunMaxSteps).optional(),
  model: z.string().min(1).max(120).optional(),
  tools: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
  temperature: z.number().min(0).max(1).optional(),
});

export type RunRequest = z.infer<typeof runRequestSchema>;

export const swarmRequestSchema = z.object({
  goal: z.string().trim().min(3).max(LIMITS.goalMaxChars),
  agents: z.number().int().min(1).max(LIMITS.swarmMaxAgents),
  concurrency: z.number().int().min(1).max(LIMITS.swarmMaxConcurrency).optional(),
  maxStepsPerAgent: z.number().int().min(1).max(LIMITS.swarmMaxStepsPerAgent).optional(),
  maxAttempts: z.number().int().min(1).max(6).optional(),
  /** Override the per-minute token ceiling. Live headers still recalibrate it. */
  tokenCeiling: z.number().int().min(500).max(1_000_000).optional(),
  model: z.string().min(1).max(120).optional(),
  synthesize: z.boolean().optional(),
});

export type SwarmRequest = z.infer<typeof swarmRequestSchema>;

export interface ApiErrorBody {
  readonly error: string;
  readonly code: string;
  readonly detail?: unknown;
}

export function badRequest(code: string, error: string, detail?: unknown): Response {
  const body: ApiErrorBody = { error, code, ...(detail === undefined ? {} : { detail }) };
  return Response.json(body, { status: 400 });
}

export function serverError(code: string, error: string, status = 500): Response {
  const body: ApiErrorBody = { error, code };
  return Response.json(body, { status });
}
