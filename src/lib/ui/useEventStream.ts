'use client';

import { useCallback, useRef, useState } from 'react';
import { parseNdjson } from '../stream';

export type StreamState = 'idle' | 'connecting' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface UseEventStreamResult<T> {
  readonly events: readonly T[];
  readonly state: StreamState;
  readonly error: string | null;
  readonly start: (url: string, body: unknown) => Promise<void>;
  readonly cancel: () => void;
  readonly reset: () => void;
  readonly load: (events: readonly T[]) => void;
}

/**
 * Consume an NDJSON endpoint into React state.
 *
 * Events are appended in a ref and flushed on an animation frame. Appending
 * directly to state re-renders once per event, and a swarm of 60 agents emits
 * thousands — enough to make the board stutter on exactly the run it is meant
 * to make legible.
 */
export function useEventStream<T>(): UseEventStreamResult<T> {
  const [events, setEvents] = useState<readonly T[]>([]);
  const [state, setState] = useState<StreamState>('idle');
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const bufferRef = useRef<T[]>([]);
  const frameRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    frameRef.current = null;
    if (bufferRef.current.length === 0) return;
    const pending = bufferRef.current;
    bufferRef.current = [];
    setEvents((previous) => [...previous, ...pending]);
  }, []);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(flush);
  }, [flush]);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    bufferRef.current = [];
    setEvents([]);
    setError(null);
    setState('idle');
  }, []);

  const load = useCallback((loaded: readonly T[]) => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    bufferRef.current = [];
    setEvents(loaded);
    setError(null);
    setState('done');
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState((current) => (current === 'streaming' || current === 'connecting' ? 'cancelled' : current));
  }, []);

  const start = useCallback(
    async (url: string, body: unknown) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      bufferRef.current = [];
      setEvents([]);
      setError(null);
      setState('connecting');

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text();
          let message = `Request failed with HTTP ${response.status}`;
          try {
            const parsed = JSON.parse(text) as { error?: string };
            if (parsed.error) message = parsed.error;
          } catch {
            if (text.trim().length > 0) message = text.slice(0, 400);
          }
          setError(message);
          setState('error');
          return;
        }
        if (!response.body) {
          setError('The server returned no response body.');
          setState('error');
          return;
        }

        setState('streaming');
        for await (const event of parseNdjson<T>(response.body)) {
          bufferRef.current.push(event);
          schedule();
        }
        flush();
        setState((current) => (current === 'cancelled' ? current : 'done'));
      } catch (caught) {
        flush();
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          setState('cancelled');
          return;
        }
        setError(caught instanceof Error ? caught.message : String(caught));
        setState('error');
      } finally {
        controllerRef.current = null;
      }
    },
    [flush, schedule],
  );

  return { events, state, error, start, cancel, reset, load };
}
