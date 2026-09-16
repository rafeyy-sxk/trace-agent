/**
 * NDJSON over the Web Streams API.
 *
 * One JSON object per line. Chosen over SSE because the payloads are already
 * JSON, there is no need for event names or reconnection semantics, and it
 * survives a proxy that buffers `text/event-stream`. Works unchanged on Vercel.
 */

export const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

export function encodeNdjsonLine(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

export interface NdjsonStreamOptions {
  readonly signal?: AbortSignal;
  /** Called when the client disconnects or the source throws. */
  readonly onClose?: () => void;
}

/**
 * Turn an async iterable into a streaming response body.
 *
 * Errors are serialised into the stream as a final `{"type":"stream_error"}`
 * line rather than tearing the connection down, so the UI can render what went
 * wrong instead of showing a truncated trace and no explanation.
 */
export function ndjsonStream<T>(
  source: AsyncIterable<T>,
  options: NdjsonStreamOptions = {},
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const value of source) {
          if (options.signal?.aborted) break;
          controller.enqueue(encodeNdjsonLine(value));
        }
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        try {
          controller.enqueue(
            encodeNdjsonLine({ type: 'stream_error', at: Date.now(), message }),
          );
        } catch {
          // The client is already gone; nothing useful left to do.
        }
      } finally {
        options.onClose?.();
        try {
          controller.close();
        } catch {
          // Already closed by a client disconnect.
        }
      }
    },
  });
}

/** Parse an NDJSON body into values. Tolerates a truncated final line. */
export async function* parseNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          try {
            yield JSON.parse(line) as T;
          } catch {
            // A partial line at a chunk boundary; the next chunk completes it.
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
    const rest = buffer.trim();
    if (rest.length > 0) {
      try {
        yield JSON.parse(rest) as T;
      } catch {
        // Truncated tail after a disconnect. Nothing to recover.
      }
    }
  } finally {
    reader.releaseLock();
  }
}
