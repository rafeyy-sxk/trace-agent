import { afterAll, beforeAll } from 'vitest';

/**
 * No test may touch the network.
 *
 * Replacing the global `fetch` with a thrower turns "this test accidentally
 * hits the internet" from a slow flaky test into an immediate, named failure.
 * Every module that makes requests takes an injected `fetchImpl` precisely so
 * this guard can stay on.
 */
const realFetch = globalThis.fetch;

class NetworkAccessInTestError extends Error {
  constructor(url: string) {
    super(
      `A test tried to reach the network: ${url}. ` +
        'Inject a fake via `fetchImpl` instead of relying on the global fetch.',
    );
    this.name = 'NetworkAccessInTestError';
  }
}

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    throw new NetworkAccessInTestError(url);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});
