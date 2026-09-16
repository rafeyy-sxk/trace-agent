import type { ChatResponse, RawToolCall } from '../groq/types';

/**
 * Turning model output into an action.
 *
 * The happy path is native `tool_calls`. The rest of this file exists because
 * models under load do three things instead: emit the JSON as prose, wrap it
 * in a fence, or emit almost-JSON with a trailing comma. Crashing on that
 * throws away a paid model call, so we recover what we can and tell the trace
 * that we did — a silent repair would be a lie about what the model produced.
 */

export interface ParsedToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  /** How the call was obtained. Surfaced in the trace. */
  readonly origin: 'native' | 'repaired-json' | 'recovered-from-text';
}

export interface ParseProblem {
  readonly code: 'unparseable-arguments' | 'recovered-from-text' | 'repaired-json' | 'empty-response';
  readonly message: string;
}

export interface ParsedModelStep {
  readonly toolCalls: readonly ParsedToolCall[];
  /** Present when the model answered instead of calling a tool. */
  readonly finalAnswer: string | null;
  readonly problems: readonly ParseProblem[];
}

/** Strip ``` fences and any language tag. */
export function stripCodeFences(text: string): string {
  const fenced = /```(?:json|javascript|js)?\s*([\s\S]*?)```/i.exec(text);
  return fenced?.[1] ? fenced[1].trim() : text.trim();
}

/**
 * Find the first balanced `{...}` or `[...]` region, respecting strings and
 * escapes. A greedy regex gets this wrong the moment a brace appears inside
 * a quoted value, which is exactly what a URL or a snippet does.
 */
export function extractBalancedJson(text: string): string | null {
  const openers: Record<string, string> = { '{': '}', '[': ']' };
  for (let start = 0; start < text.length; start += 1) {
    const char = text[start] as string;
    const closer = openers[char];
    if (!closer) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const current = text[i] as string;
      if (inString) {
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '"') inString = false;
        continue;
      }
      if (current === '"') {
        inString = true;
        continue;
      }
      if (current === char) depth += 1;
      else if (current === closer) {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Remove trailing commas before a closing brace or bracket. */
function dropTrailingCommas(json: string): string {
  return json.replace(/,(\s*[}\]])/g, '$1');
}

export interface JsonRepairResult {
  readonly value: unknown;
  readonly repaired: boolean;
}

/** Parse JSON, then try progressively more forgiving repairs. */
export function parseJsonLoose(raw: string): JsonRepairResult | null {
  const attempts: Array<{ text: string; repaired: boolean }> = [];
  const trimmed = raw.trim();
  attempts.push({ text: trimmed, repaired: false });
  const unfenced = stripCodeFences(trimmed);
  if (unfenced !== trimmed) attempts.push({ text: unfenced, repaired: true });
  const balanced = extractBalancedJson(unfenced);
  if (balanced && balanced !== unfenced) attempts.push({ text: balanced, repaired: true });
  for (const attempt of [...attempts]) {
    const cleaned = dropTrailingCommas(attempt.text);
    if (cleaned !== attempt.text) attempts.push({ text: cleaned, repaired: true });
  }

  for (const attempt of attempts) {
    if (attempt.text.length === 0) continue;
    try {
      return { value: JSON.parse(attempt.text) as unknown, repaired: attempt.repaired };
    } catch {
      // try the next repair
    }
  }
  return null;
}

/** Keys a model plausibly uses when it writes a tool call as prose. */
const NAME_KEYS = ['tool', 'name', 'tool_name', 'function', 'action'] as const;
const ARG_KEYS = ['args', 'arguments', 'parameters', 'params', 'input', 'action_input'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Last-resort recovery: the model described a tool call in its message text
 * instead of using the tool-calling channel.
 */
export function recoverToolCallFromText(
  text: string,
  knownTools: readonly string[],
): { name: string; args: unknown } | null {
  const parsed = parseJsonLoose(text);
  const record = parsed ? asRecord(parsed.value) : null;
  if (!record) return null;

  let name: string | null = null;
  for (const key of NAME_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && knownTools.includes(candidate)) {
      name = candidate;
      break;
    }
    const nested = asRecord(candidate);
    if (nested && typeof nested.name === 'string' && knownTools.includes(nested.name)) {
      name = nested.name;
      break;
    }
  }
  if (!name) return null;

  for (const key of ARG_KEYS) {
    const candidate = record[key];
    if (candidate === undefined) continue;
    if (typeof candidate === 'string') {
      const inner = parseJsonLoose(candidate);
      return { name, args: inner ? inner.value : { input: candidate } };
    }
    const nested = asRecord(candidate);
    if (nested) return { name, args: nested };
  }
  return { name, args: {} };
}

function parseNativeCall(call: RawToolCall): { args: unknown; repaired: boolean } | null {
  const raw = call.function.arguments?.trim() ?? '';
  if (raw === '') return { args: {}, repaired: false };
  const parsed = parseJsonLoose(raw);
  if (!parsed) return null;
  return { args: parsed.value, repaired: parsed.repaired };
}

/**
 * Interpret one model turn: which tools to call, or the final answer.
 * Never throws — an uninterpretable turn comes back as a problem list the
 * agent loop can hand straight back to the model.
 */
export function parseModelStep(
  response: ChatResponse,
  knownTools: readonly string[],
): ParsedModelStep {
  const toolCalls: ParsedToolCall[] = [];
  const problems: ParseProblem[] = [];

  for (const call of response.toolCalls) {
    const parsed = parseNativeCall(call);
    if (!parsed) {
      problems.push({
        code: 'unparseable-arguments',
        message: `Arguments for "${call.function.name}" were not valid JSON: ${call.function.arguments.slice(0, 200)}`,
      });
      continue;
    }
    if (parsed.repaired) {
      problems.push({
        code: 'repaired-json',
        message: `Arguments for "${call.function.name}" needed repair before they parsed.`,
      });
    }
    toolCalls.push({
      id: call.id,
      name: call.function.name,
      args: parsed.args,
      origin: parsed.repaired ? 'repaired-json' : 'native',
    });
  }

  const content = response.content.trim();

  if (toolCalls.length === 0 && content.length > 0) {
    const recovered = recoverToolCallFromText(content, knownTools);
    if (recovered) {
      problems.push({
        code: 'recovered-from-text',
        message: `The model wrote a "${recovered.name}" call into its message instead of using the tool channel; recovered it.`,
      });
      return {
        toolCalls: [
          {
            id: `recovered_${Date.now().toString(36)}`,
            name: recovered.name,
            args: recovered.args,
            origin: 'recovered-from-text',
          },
        ],
        finalAnswer: null,
        problems,
      };
    }
  }

  if (toolCalls.length > 0) {
    return { toolCalls, finalAnswer: null, problems };
  }

  if (content.length === 0) {
    problems.push({
      code: 'empty-response',
      message: 'The model returned neither a tool call nor any text.',
    });
    return { toolCalls: [], finalAnswer: null, problems };
  }

  return { toolCalls: [], finalAnswer: content, problems };
}

/**
 * Map a tool name the model produced onto a name we actually offer.
 *
 * Models truncate and abbreviate tool names under load — `wiki...` for
 * `wikipedia` was observed live. Matching is deliberately conservative:
 * an ambiguous candidate resolves to nothing rather than to a plausible
 * guess, because calling the wrong tool is worse than calling none.
 */
export function resolveToolName(
  candidate: string,
  knownTools: readonly string[],
): string | null {
  const raw = candidate.trim();
  if (raw.length === 0) return null;
  if (knownTools.includes(raw)) return raw;

  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalized = normalize(raw);
  if (normalized.length < 3) return null;

  const exact = knownTools.filter((tool) => normalize(tool) === normalized);
  if (exact.length === 1) return exact[0] as string;

  const prefixed = knownTools.filter((tool) => normalize(tool).startsWith(normalized));
  if (prefixed.length === 1) return prefixed[0] as string;

  return null;
}

export interface RecoveredToolCall {
  readonly name: string;
  readonly args: unknown;
  readonly rawName: string;
}

/**
 * Recover the call the model meant from a provider `failed_generation` blob.
 * Returns null unless the intended tool resolves unambiguously.
 */
export function recoverFromFailedGeneration(
  failedGeneration: string | null,
  knownTools: readonly string[],
): RecoveredToolCall | null {
  if (!failedGeneration) return null;
  const parsed = parseJsonLoose(failedGeneration);
  if (!parsed || typeof parsed.value !== 'object' || parsed.value === null) return null;
  const record = parsed.value as Record<string, unknown>;
  const rawName = typeof record.name === 'string' ? record.name : null;
  if (!rawName) return null;
  const name = resolveToolName(rawName, knownTools);
  if (!name) return null;
  const args = record.arguments ?? record.args ?? {};
  if (typeof args === 'string') {
    const inner = parseJsonLoose(args);
    return { name, args: inner ? inner.value : {}, rawName };
  }
  return { name, args, rawName };
}
