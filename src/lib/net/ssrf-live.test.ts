import { beforeAll, describe, expect, it } from 'vitest';
import { runTool, toolRegistry } from '../tools';

/**
 * A LIVE proof of the SSRF guard, against real listening sockets.
 *
 * Skipped unless TRACE_AGENT_LIVE=1, so `pnpm test` stays hermetic. Run it with
 * a real server on 127.0.0.1:8080 to prove the refusals are the guard doing its
 * job rather than a dead port:
 *
 *   python3 -m http.server 8080 --bind 127.0.0.1 &
 *   TRACE_AGENT_LIVE=1 pnpm exec vitest run src/lib/net/ssrf-live.test.ts
 */

const LIVE = process.env.TRACE_AGENT_LIVE === '1';
const fetchUrl = toolRegistry().get('fetch_url');
const maybe = LIVE ? describe : describe.skip;

// The global setup file replaces fetch with a thrower. This suite needs the
// real one, and its beforeAll runs after the setup file's.
const realFetch = globalThis.fetch;

maybe('SSRF guard, live', () => {
  beforeAll(() => {
    globalThis.fetch = realFetch;
  });

  it('positive control: the loopback target is genuinely reachable', async () => {
    const response = await realFetch('http://127.0.0.1:8080/', { method: 'GET' });
    expect(response.status).toBe(200);
  });

  it('refuses http://127.0.0.1:8080 even though a server is listening there', async () => {
    const outcome = await runTool(fetchUrl, 'fetch_url', { url: 'http://127.0.0.1:8080' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    console.warn(`127.0.0.1:8080 -> [${outcome.error.kind}] ${outcome.error.message}`);
    expect(outcome.error.kind).toBe('refused');
  });

  it('refuses file:///etc/passwd even though the file is readable', async () => {
    const outcome = await runTool(fetchUrl, 'fetch_url', { url: 'file:///etc/passwd' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    console.warn(`file:///etc/passwd -> [${outcome.error.kind}] ${outcome.error.message}`);
    expect(outcome.error.kind).toBe('refused');
  });

  it.each([
    'http://127.0.0.1:5310/api/models',
    'http://localhost:8080/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://[::1]:5432/',
    'http://2130706433/',
  ])('refuses %s', async (url) => {
    const outcome = await runTool(fetchUrl, 'fetch_url', { url });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    console.warn(`${url} -> [${outcome.error.kind}] ${outcome.error.message}`);
  });

  it('positive control: a real public URL is allowed and returns real text', async () => {
    const outcome = await runTool(fetchUrl, 'fetch_url', {
      url: 'https://en.wikipedia.org/wiki/Tokyo',
      max_chars: 400,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const result = outcome.result as { status: number; charCount: number; title: string | null };
    console.warn(
      `https://en.wikipedia.org/wiki/Tokyo -> ALLOWED HTTP ${result.status}, ${result.charCount} chars, title=${JSON.stringify(result.title)}`,
    );
    expect(result.status).toBe(200);
    expect(result.charCount).toBeGreaterThan(300);
  });
});
