import type { RunTrace, TraceEvent } from './agent/types';

/**
 * Trace sharing and replay.
 *
 * A trace is gzipped and base64url-encoded into the URL fragment. The fragment
 * never leaves the browser, so a shared run does not touch a server, a
 * database or an object store — which is also why there is no "runs" table in
 * this project and no claim of one.
 *
 * Browsers cap URL length well below what a trace with full raw tool payloads
 * can reach, so sharing degrades in named steps and says which one it took.
 */

export const SHARE_PREFIX_GZIP = 'g1.';
export const SHARE_PREFIX_RAW = 'r1.';
/** Chrome tolerates far more; this keeps a shared link pasteable everywhere. */
export const MAX_SHARE_CHARS = 28_000;

export type ShareFidelity = 'full' | 'no-raw-results' | 'trimmed-observations' | 'too-large';

export interface SharePayload {
  readonly token: string;
  readonly fidelity: ShareFidelity;
  readonly chars: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gzip(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Strip the raw typed tool results, keeping the observation the model saw. */
function withoutRawResults(trace: RunTrace): RunTrace {
  // A trace can arrive from an uploaded file, so never assume the shape.
  if (!Array.isArray(trace.events)) return trace;
  const events: TraceEvent[] = trace.events.map((event) => {
    if (event.type !== 'tool_result' || event.result === undefined) return event;
    const { result: _dropped, ...rest } = event;
    return rest as TraceEvent;
  });
  return { ...trace, events };
}

/** Additionally clip long observations. Last stop before giving up. */
function withTrimmedObservations(trace: RunTrace, max = 400): RunTrace {
  if (!Array.isArray(trace.events)) return trace;
  const events: TraceEvent[] = trace.events.map((event) => {
    if (event.type !== 'tool_result' || event.observation.length <= max) return event;
    return { ...event, observation: `${event.observation.slice(0, max)}…[trimmed for sharing]` };
  });
  return { ...trace, events };
}

async function encodeOnce(trace: RunTrace): Promise<string> {
  const json = JSON.stringify(trace);
  const compressed = await gzip(json);
  if (compressed) return SHARE_PREFIX_GZIP + toBase64Url(compressed);
  return SHARE_PREFIX_RAW + toBase64Url(new TextEncoder().encode(json));
}

/**
 * Encode a trace for a URL, shedding detail only as far as needed and
 * reporting exactly how much fidelity survived.
 */
export async function encodeTrace(trace: RunTrace): Promise<SharePayload> {
  const attempts: Array<{ trace: RunTrace; fidelity: ShareFidelity }> = [
    { trace, fidelity: 'full' },
    { trace: withoutRawResults(trace), fidelity: 'no-raw-results' },
    { trace: withTrimmedObservations(withoutRawResults(trace)), fidelity: 'trimmed-observations' },
  ];
  let last: SharePayload = { token: '', fidelity: 'too-large', chars: 0 };
  for (const attempt of attempts) {
    const token = await encodeOnce(attempt.trace);
    last = { token, fidelity: attempt.fidelity, chars: token.length };
    if (token.length <= MAX_SHARE_CHARS) return last;
  }
  return { token: last.token, fidelity: 'too-large', chars: last.chars };
}

export class TraceDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceDecodeError';
  }
}

export async function decodeTrace(token: string): Promise<RunTrace> {
  let json: string;
  try {
    if (token.startsWith(SHARE_PREFIX_GZIP)) {
      json = await gunzip(fromBase64Url(token.slice(SHARE_PREFIX_GZIP.length)));
    } else if (token.startsWith(SHARE_PREFIX_RAW)) {
      json = new TextDecoder().decode(fromBase64Url(token.slice(SHARE_PREFIX_RAW.length)));
    } else {
      throw new TraceDecodeError('The share token has an unrecognised prefix.');
    }
  } catch (error) {
    if (error instanceof TraceDecodeError) throw error;
    throw new TraceDecodeError('The share token could not be decoded.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TraceDecodeError('The share token did not contain valid JSON.');
  }
  if (!isRunTrace(parsed)) {
    throw new TraceDecodeError('The decoded payload is not a trace.');
  }
  return parsed;
}

/** Structural check. A shared link is untrusted input like any other. */
export function isRunTrace(value: unknown): value is RunTrace {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RunTrace>;
  return (
    typeof candidate.runId === 'string' &&
    typeof candidate.goal === 'string' &&
    typeof candidate.model === 'string' &&
    typeof candidate.status === 'string' &&
    Array.isArray(candidate.events) &&
    candidate.events.every(
      (event) => typeof event === 'object' && event !== null && typeof (event as TraceEvent).type === 'string',
    )
  );
}
