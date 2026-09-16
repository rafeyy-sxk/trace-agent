import { describe, expect, it, vi } from 'vitest';
import { HttpTimeoutError, safeFetch } from './http';
import { UrlRefusedError, type DnsResolver } from './ssrf';

const resolve: DnsResolver = async () => ['93.184.216.34'];

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
    ...init,
  });
}

describe('safeFetch', () => {
  it('should return the body, status and content type of a successful request', async () => {
    const fetchImpl = vi.fn(async () => textResponse('hello world'));
    const result = await safeFetch('https://example.com/', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolve,
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('hello world');
    expect(result.truncated).toBe(false);
    expect(result.redirectChain).toEqual(['https://example.com/']);
  });

  it('should refuse before making any request when the URL is private', async () => {
    const fetchImpl = vi.fn(async () => textResponse('never'));
    await expect(
      safeFetch('http://127.0.0.1:8080/', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolve,
      }),
    ).rejects.toBeInstanceOf(UrlRefusedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('should re-run the guard on a redirect and refuse a hop to a private address', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/') {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
      }
      return textResponse('metadata');
    });
    await expect(
      safeFetch('https://example.com/', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolve,
      }),
    ).rejects.toMatchObject({ name: 'UrlRefusedError', reason: 'private-address' });
    // The first hop was fetched; the second never was.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('should follow a redirect to another public URL and record the chain', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/') {
        return new Response(null, { status: 301, headers: { location: 'https://example.org/final' } });
      }
      return textResponse('arrived');
    });
    const result = await safeFetch('https://example.com/', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolve,
    });
    expect(result.body).toBe('arrived');
    expect(result.redirectChain).toEqual(['https://example.com/', 'https://example.org/final']);
  });

  it('should refuse a redirect loop once the hop cap is passed', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } }),
    );
    await expect(
      safeFetch('https://example.com/', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolve,
        maxRedirects: 2,
      }),
    ).rejects.toMatchObject({ reason: 'too-many-redirects' });
  });

  it('should stop reading at the byte cap and flag the result as truncated', async () => {
    const big = 'x'.repeat(5_000);
    const fetchImpl = vi.fn(async () => textResponse(big));
    const result = await safeFetch('https://example.com/', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolve,
      maxBytes: 1_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(1_000);
  });

  it('should raise a timeout error when the response never arrives', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    await expect(
      safeFetch('https://example.com/', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolve,
        timeoutMs: 20,
      }),
    ).rejects.toBeInstanceOf(HttpTimeoutError);
  });
});
