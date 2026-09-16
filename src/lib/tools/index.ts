import { z } from 'zod/v4';
import { UrlRefusedError } from '../net/ssrf';
import { HttpTimeoutError } from '../net/http';
import { arxivTool } from './arxiv';
import { calculatorTool } from './calculator';
import { datetimeTool } from './datetime';
import { fetchUrlTool } from './fetch-url';
import { wikipediaTool } from './wikipedia';
import type { AnyTool, Tool, ToolContext, ToolFailure, ToolOutcome } from './types';

export type { Tool, ToolContext, ToolOutcome, ToolFailure, ToolErrorKind } from './types';
export { arxivTool, calculatorTool, datetimeTool, fetchUrlTool, wikipediaTool };

/** The registry. Order is the order the model sees, which biases selection. */
export const ALL_TOOLS = [
  wikipediaTool,
  fetchUrlTool,
  arxivTool,
  calculatorTool,
  datetimeTool,
] as unknown as readonly AnyTool[];

export type ToolName = (typeof ALL_TOOLS)[number]['name'];

export function toolRegistry(tools: readonly AnyTool[] = ALL_TOOLS): Map<string, AnyTool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export interface ToolSpec {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/**
 * Render tools as OpenAI-compatible function specs.
 *
 * The JSON Schema is derived from the same zod schema that validates the
 * arguments at execution time, so the contract shown to the model and the
 * contract enforced on its output can never drift apart.
 */
export function toolSpecs(tools: readonly AnyTool[] = ALL_TOOLS): ToolSpec[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.schema as z.ZodType<unknown>, {
        target: 'draft-7',
        io: 'input',
      }) as Record<string, unknown>,
    },
  }));
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** Turn any thrown value into a message the model can act on. */
function failureFrom(error: unknown): ToolFailure {
  if (error instanceof UrlRefusedError) {
    return { kind: 'refused', message: error.message };
  }
  if (error instanceof HttpTimeoutError) {
    return { kind: 'timeout', message: error.message };
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return { kind: 'cancelled', message: 'The tool call was cancelled.' };
    }
    return { kind: 'failed', message: `${error.name}: ${error.message}` };
  }
  return { kind: 'failed', message: `Unknown failure: ${String(error)}` };
}

class ToolTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Tool "${name}" exceeded its ${timeoutMs}ms budget`);
    this.name = 'ToolTimeoutError';
  }
}

/**
 * Validate, execute and time a tool call.
 *
 * Never throws. A tool failure is data the agent loop feeds back to the model
 * so it can recover, which is the whole point of showing the model its own
 * mistakes rather than crashing the run.
 */
export async function runTool(
  tool: AnyTool | undefined,
  toolName: string,
  rawArgs: unknown,
  context: ToolContext = {},
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  if (!tool) {
    return {
      ok: false,
      durationMs: elapsed(),
      error: { kind: 'unknown-tool', message: `There is no tool named "${toolName}".` },
    };
  }

  const parsed = (tool.schema as z.ZodType<unknown>).safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      durationMs: elapsed(),
      error: {
        kind: 'invalid-args',
        message: `Invalid arguments for "${toolName}" — ${describeZodError(parsed.error)}`,
      },
    };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  context.signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, tool.timeoutMs);

  try {
    const execution = (tool as Tool<unknown, unknown>).execute(parsed.data, {
      ...context,
      signal: controller.signal,
    });
    const guard = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          reject(
            timedOut
              ? new ToolTimeoutError(toolName, tool.timeoutMs)
              : Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
          );
        },
        { once: true },
      );
    });
    const result = await Promise.race([execution, guard]);
    return {
      ok: true,
      result,
      observation: (tool as Tool<unknown, unknown>).observe(result),
      durationMs: elapsed(),
    };
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        durationMs: elapsed(),
        error: {
          kind: 'timeout',
          message: `Tool "${toolName}" exceeded its ${tool.timeoutMs}ms budget.`,
        },
      };
    }
    return { ok: false, durationMs: elapsed(), error: failureFrom(error) };
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener('abort', onAbort);
  }
}
