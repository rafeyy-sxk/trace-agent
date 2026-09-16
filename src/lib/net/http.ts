/**
 * The only outbound HTTP door in the app.
 *
 * Adds three things plain `fetch` does not give us:
 *   - a hard wall-clock timeout (Vercel bills for the hang too),
 *   - a response byte cap enforced while streaming, not after,
 *   - redirect following that re-runs the SSRF guard on every hop.
 */

import { assertPublicHttpUrl, UrlRefusedError, type DnsResolver } from './ssrf';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 4;

export class HttpTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'HttpTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class ResponseTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(url: string, maxBytes: number) {
    super(`Response from ${url} exceeded the ${maxBytes} byte cap`);
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export interface SafeFetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly headers?: Record<string, string>;
  readonly resolve?: DnsResolver;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

export interface SafeFetchResult {
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly truncated: boolean;
  readonly bytes: number;
  /** Every URL visited, starting with the requested one. */
  readonly redirectChain: readonly string[];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Read a response body, stopping hard at `maxBytes`. */
async function readCapped(
  response: Response,
  url: string,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean; bytes: number }> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number(declared);
    // A body that advertises more than 8x the cap is a download, not a page.
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes * 8) {
      throw new ResponseTooLargeError(url, maxBytes);
    }
  }

  const stream = response.body;
  if (!stream) {
    const text = await response.text();
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength <= maxBytes) {
      return { body: text, truncated: false, bytes: encoded.byteLength };
    }
    return {
      body: new TextDecoder().decode(encoded.slice(0, maxBytes)),
      truncated: true,
      bytes: maxBytes,
    };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    body: new TextDecoder('utf-8', { fatal: false }).decode(merged),
    truncated,
    bytes: total,
  };
}

/**
 * Fetch a URL with the SSRF guard applied to the request and to every
 * redirect hop. Throws `UrlRefusedError`, `HttpTimeoutError` or
 * `ResponseTooLargeError`; network failures propagate as-is.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const redirectChain: string[] = [];
  let current = rawUrl;

  try {
    for (let hop = 0; ; hop += 1) {
      if (hop > maxRedirects) {
        throw new UrlRefusedError(
          'too-many-redirects',
          rawUrl,
          `it redirected more than ${maxRedirects} times`,
        );
      }

      const guarded = await assertPublicHttpUrl(current, { resolve: options.resolve });
      redirectChain.push(guarded.url.toString());

      let response: Response;
      try {
        response = await doFetch(guarded.url.toString(), {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'user-agent': 'trace-agent/1.0 (+https://github.com/trace-agent)',
            ...options.headers,
          },
        });
      } catch (error) {
        if (timedOut) throw new HttpTimeoutError(current, timeoutMs);
        throw error;
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        // Drain so the socket is released before we follow the hop.
        await response.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new UrlRefusedError(
            'malformed-url',
            current,
            `it returned ${response.status} without a Location header`,
          );
        }
        current = new URL(location, guarded.url).toString();
        continue;
      }

      const read = await readCapped(response, guarded.url.toString(), maxBytes);
      return {
        finalUrl: guarded.url.toString(),
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: read.body,
        truncated: read.truncated,
        bytes: read.bytes,
        redirectChain,
      };
    }
  } catch (error) {
    if (timedOut && !(error instanceof HttpTimeoutError)) {
      throw new HttpTimeoutError(current, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
