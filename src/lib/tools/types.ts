import type { z } from 'zod/v4';
import type { DnsResolver } from '../net/ssrf';

/** Everything a tool is allowed to reach. Injected, so tests stay hermetic. */
export interface ToolContext {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly resolve?: DnsResolver;
  /** Injected clock. The date tool is untestable without it. */
  readonly now?: () => Date;
}

export interface Tool<TArgs = unknown, TResult = unknown> {
  readonly name: string;
  readonly title: string;
  /** Shown to the model. Worth more than the schema for tool selection. */
  readonly description: string;
  readonly schema: z.ZodType<TArgs>;
  readonly timeoutMs: number;
  execute(args: TArgs, context: ToolContext): Promise<TResult>;
  /**
   * Render the typed result as the text the model observes. The UI always
   * shows the untouched typed result; this is only the model's view.
   */
  observe(result: TResult): string;
}

export type AnyTool = Tool<never, unknown>;

export type ToolErrorKind =
  | 'invalid-args'
  | 'unknown-tool'
  | 'timeout'
  | 'refused'
  | 'failed'
  | 'cancelled';

export interface ToolFailure {
  readonly kind: ToolErrorKind;
  readonly message: string;
}

export type ToolOutcome<TResult = unknown> =
  | { readonly ok: true; readonly result: TResult; readonly observation: string; readonly durationMs: number }
  | { readonly ok: false; readonly error: ToolFailure; readonly durationMs: number };
