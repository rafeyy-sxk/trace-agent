import { describe, expect, it, vi } from 'vitest';
import { ExpressionError, evaluateExpression } from '../math/expression';
import { ALL_TOOLS, runTool, toolRegistry, toolSpecs } from './index';
import { arxivTool, parseArxivFeed } from './arxiv';
import { calculatorTool } from './calculator';
import { datetimeTool } from './datetime';
import { fetchUrlTool } from './fetch-url';
import { wikipediaTool } from './wikipedia';
import type { AnyTool, ToolContext } from './types';
import type { DnsResolver } from '../net/ssrf';

const resolve: DnsResolver = async () => ['93.184.216.34'];
const registry = toolRegistry();

function context(fetchImpl: typeof fetch, extra: Partial<ToolContext> = {}): ToolContext {
  return { fetchImpl, resolve, ...extra };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

/** A fetch that never resolves until its signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_res, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  );
}

// ---------------------------------------------------------------- calculator

describe('calculator', () => {
  it('should evaluate arithmetic with correct precedence and associativity', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512); // right-associative
    expect(evaluateExpression('-4 + 10')).toBe(6);
    expect(evaluateExpression('max(3, 9, 4) - min(2, 8)')).toBe(7);
    expect(evaluateExpression('sqrt(144) / 2')).toBe(6);
  });

  it('should return an exact result on the happy path through the tool', async () => {
    const outcome = await runTool(registry.get('calculator'), 'calculator', {
      expression: '(37600000 - 8300000) / 8300000 * 100',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect((outcome.result as { value: number }).value).toBeCloseTo(353.01, 1);
    expect(outcome.observation).toContain('=');
  });

  it('should never evaluate arbitrary code because identifiers do not resolve against the host', () => {
    expect(() => evaluateExpression('process.exit(1)')).toThrow(ExpressionError);
    expect(() => evaluateExpression('globalThis')).toThrow(ExpressionError);
    expect(() => evaluateExpression('constructor')).toThrow(ExpressionError);
    expect(() => evaluateExpression('require("fs")')).toThrow(ExpressionError);
  });

  it('should refuse an exponent large enough to hang the process', () => {
    expect(() => evaluateExpression('9^9^9')).toThrow(/Exponent/);
  });

  it('should reject malformed arguments before executing', async () => {
    const outcome = await runTool(registry.get('calculator'), 'calculator', { expr: '1+1' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('invalid-args');
    expect(outcome.error.message).toContain('expression');
  });

  it('should report division by zero as a tool failure rather than throwing', async () => {
    const outcome = await runTool(registry.get('calculator'), 'calculator', { expression: '1/0' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.message).toContain('Division by zero');
  });
});

// ------------------------------------------------------------------ datetime

describe('current_datetime', () => {
  it('should report the injected instant in the requested timezone', async () => {
    const fixed = new Date('2026-03-01T00:30:00.000Z');
    const outcome = await runTool(
      registry.get('current_datetime'),
      'current_datetime',
      { timezone: 'Asia/Tokyo' },
      { now: () => fixed },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const result = outcome.result as { date: string; weekday: string; utcOffset: string };
    expect(result.date).toBe('2026-03-01');
    expect(result.weekday).toBe('Sunday');
    expect(result.utcOffset).toBe('+09:00');
  });

  it('should apply a day offset', async () => {
    const fixed = new Date('2026-03-01T12:00:00.000Z');
    const outcome = await runTool(
      registry.get('current_datetime'),
      'current_datetime',
      { timezone: 'UTC', offset_days: -1 },
      { now: () => fixed },
    );
    if (!outcome.ok) throw new Error('unreachable');
    expect((outcome.result as { date: string }).date).toBe('2026-02-28');
  });

  it('should fail cleanly on an unknown timezone', async () => {
    const outcome = await runTool(registry.get('current_datetime'), 'current_datetime', {
      timezone: 'Mars/Olympus_Mons',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('failed');
    expect(outcome.error.message).toContain('not a recognised IANA timezone');
  });

  it('should reject a malformed offset', async () => {
    const outcome = await runTool(registry.get('current_datetime'), 'current_datetime', {
      offset_days: 'tomorrow',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('invalid-args');
  });
});

// ----------------------------------------------------------------- fetch_url

describe('fetch_url', () => {
  it('should extract readable text and the title from an HTML page', async () => {
    const fetchImpl = vi.fn(async () =>
      html(
        '<html><head><title>Tokyo</title><meta name="description" content="A city"></head>' +
          '<body><nav>skip me</nav><script>var x=1</script>' +
          '<article><p>Tokyo is the capital of Japan.</p><p>It has 14 million residents.</p></article>' +
          '<footer>drop this</footer></body></html>',
      ),
    );
    const outcome = await runTool(
      registry.get('fetch_url'),
      'fetch_url',
      { url: 'https://example.com/tokyo' },
      context(fetchImpl as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const result = outcome.result as { title: string; text: string };
    expect(result.title).toBe('Tokyo');
    expect(result.text).toContain('capital of Japan');
    expect(result.text).toContain('14 million');
    expect(result.text).not.toContain('skip me');
    expect(result.text).not.toContain('var x=1');
    expect(result.text).not.toContain('drop this');
  });

  it('should refuse an SSRF target and never call fetch', async () => {
    const fetchImpl = vi.fn(async () => html('<p>secret</p>'));
    const outcome = await runTool(
      registry.get('fetch_url'),
      'fetch_url',
      { url: 'http://127.0.0.1:8080/admin' },
      context(fetchImpl as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('refused');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('should refuse a file scheme URL', async () => {
    const fetchImpl = vi.fn(async () => html('root:x:0:0'));
    const outcome = await runTool(
      registry.get('fetch_url'),
      'fetch_url',
      { url: 'file:///etc/passwd' },
      context(fetchImpl as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('refused');
    expect(outcome.error.message).toContain('file');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('should reject a relative URL without ever fetching', async () => {
    const fetchImpl = vi.fn(async () => html('<p>x</p>'));
    const outcome = await runTool(
      registry.get('fetch_url'),
      'fetch_url',
      { url: '/etc/passwd' },
      context(fetchImpl as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('should report a timeout when the page never responds', async () => {
    const tool: AnyTool = { ...fetchUrlTool, timeoutMs: 30 } as unknown as AnyTool;
    const outcome = await runTool(
      tool,
      'fetch_url',
      { url: 'https://example.com/slow' },
      context(hangingFetch() as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('timeout');
  });

  it('should say so plainly when the response is not textual', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('PNGDATA', { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const outcome = await runTool(
      registry.get('fetch_url'),
      'fetch_url',
      { url: 'https://example.com/a.png' },
      context(fetchImpl as unknown as typeof fetch),
    );
    if (!outcome.ok) throw new Error('unreachable');
    expect((outcome.result as { text: string }).text).toContain('no readable text');
  });
});

// ----------------------------------------------------------------- wikipedia

describe('wikipedia', () => {
  const searchPayload = {
    query: {
      searchinfo: { totalhits: 8172 },
      search: [
        { title: 'Tokyo', pageid: 1, snippet: 'Tokyo is the <span>capital</span>' },
        { title: 'Greater Tokyo Area', pageid: 2, snippet: 'the largest metro area' },
      ],
    },
  };
  const summaryPayload = {
    title: 'Tokyo',
    description: 'Capital of Japan',
    extract: 'Tokyo is the capital and most populous city of Japan.',
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Tokyo' } },
  };
  const wikiFetch = () =>
    vi.fn(async (url: string) =>
      url.includes('/api/rest_v1/') ? json(summaryPayload) : json(searchPayload),
    );

  it('should search and attach the summary of the top hit', async () => {
    const fetchImpl = wikiFetch();
    const outcome = await runTool(
      registry.get('wikipedia'),
      'wikipedia',
      { query: 'Tokyo population' },
      context(fetchImpl as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const result = outcome.result as {
      hits: unknown[];
      summary: { extract: string } | null;
      totalHits: number;
    };
    expect(result.hits).toHaveLength(2);
    expect(result.totalHits).toBe(8172);
    expect(result.summary?.extract).toContain('capital');
    expect(outcome.observation).toContain('https://en.wikipedia.org/wiki/Tokyo');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('should strip the markup Wikipedia puts inside snippets', async () => {
    const outcome = await runTool(
      registry.get('wikipedia'),
      'wikipedia',
      { query: 'Tokyo' },
      context(wikiFetch() as unknown as typeof fetch),
    );
    if (!outcome.ok) throw new Error('unreachable');
    const hits = (outcome.result as { hits: Array<{ snippet: string }> }).hits;
    expect(hits[0]?.snippet).toBe('Tokyo is the capital');
  });

  it('should return an empty honest result when nothing matches', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ query: { searchinfo: { totalhits: 0 }, search: [] } }),
    );
    const outcome = await runTool(
      registry.get('wikipedia'),
      'wikipedia',
      { query: 'qwertyuiopasdfgh' },
      context(fetchImpl as unknown as typeof fetch),
    );
    if (!outcome.ok) throw new Error('unreachable');
    expect((outcome.result as { hits: unknown[] }).hits).toHaveLength(0);
    expect(outcome.observation).toContain('No Wikipedia articles matched');
  });

  it('should reject a malformed language code before fetching', async () => {
    const fetchImpl = wikiFetch();
    const outcome = await runTool(
      registry.get('wikipedia'),
      'wikipedia',
      { query: 'Tokyo', language: '../../etc' },
      context(fetchImpl as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('invalid-args');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('should surface a non-JSON response as a tool failure', async () => {
    const fetchImpl = vi.fn(async () => html('<html>503</html>'));
    const outcome = await runTool(
      registry.get('wikipedia'),
      'wikipedia',
      { query: 'Tokyo' },
      context(fetchImpl as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.message).toContain('non-JSON');
  });

  it('should time out rather than hang', async () => {
    const tool: AnyTool = { ...wikipediaTool, timeoutMs: 30 } as unknown as AnyTool;
    const outcome = await runTool(
      tool,
      'wikipedia',
      { query: 'Tokyo' },
      context(hangingFetch() as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('timeout');
  });
});

// --------------------------------------------------------------------- arxiv

const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults>259993</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2209.15001v3</id>
    <title>Dilated Neighborhood Attention Transformer</title>
    <summary>Transformers are quickly becoming one of the most applied architectures.</summary>
    <published>2022-09-29T18:59:35Z</published>
    <updated>2023-01-16T18:58:58Z</updated>
    <author><name>Ali Hassani</name></author>
    <author><name>Humphrey Shi</name></author>
    <link href="https://arxiv.org/abs/2209.15001v3" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2209.15001v3" rel="related" type="application/pdf" title="pdf"/>
    <category term="cs.CV" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

function atom(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/atom+xml' },
  });
}

describe('arxiv_search', () => {
  it('should parse an Atom feed into typed papers', () => {
    const result = parseArxivFeed(ARXIV_FEED, 'attention');
    expect(result.totalResults).toBe(259993);
    expect(result.papers).toHaveLength(1);
    const paper = result.papers[0]!;
    expect(paper.id).toBe('2209.15001v3');
    expect(paper.title).toBe('Dilated Neighborhood Attention Transformer');
    expect(paper.authors).toEqual(['Ali Hassani', 'Humphrey Shi']);
    expect(paper.pdfUrl).toBe('https://arxiv.org/pdf/2209.15001v3');
    expect(paper.categories).toEqual(['cs.CV']);
  });

  it('should return papers through the tool and cite their URLs', async () => {
    const fetchImpl = vi.fn(async () => atom(ARXIV_FEED));
    const outcome = await runTool(
      registry.get('arxiv_search'),
      'arxiv_search',
      { query: 'attention', max_results: 1 },
      context(fetchImpl as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.observation).toContain('https://arxiv.org/abs/2209.15001v3');
  });

  it('should reject max_results outside the allowed range', async () => {
    const fetchImpl = vi.fn(async () => atom(ARXIV_FEED));
    const outcome = await runTool(
      registry.get('arxiv_search'),
      'arxiv_search',
      { query: 'attention', max_results: 500 },
      context(fetchImpl as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('invalid-args');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('should fail clearly when the response is not an Atom feed', async () => {
    const fetchImpl = vi.fn(async () => html('<html>maintenance</html>'));
    const outcome = await runTool(
      registry.get('arxiv_search'),
      'arxiv_search',
      { query: 'attention' },
      context(fetchImpl as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.message).toContain('Atom feed');
  });

  it('should time out rather than hang', async () => {
    const tool: AnyTool = { ...arxivTool, timeoutMs: 30 } as unknown as AnyTool;
    const outcome = await runTool(
      tool,
      'arxiv_search',
      { query: 'attention' },
      context(hangingFetch() as unknown as typeof fetch),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('timeout');
  });
});

// ------------------------------------------------------------------ registry

describe('tool registry', () => {
  it('should expose exactly the five keyless tools', () => {
    expect(ALL_TOOLS.map((tool) => tool.name).sort()).toEqual([
      'arxiv_search',
      'calculator',
      'current_datetime',
      'fetch_url',
      'wikipedia',
    ]);
  });

  it('should derive every JSON Schema from the zod schema that validates the call', () => {
    const specs = toolSpecs();
    expect(specs).toHaveLength(ALL_TOOLS.length);
    for (const spec of specs) {
      expect(spec.type).toBe('function');
      expect(spec.function.description.length).toBeGreaterThan(40);
      expect(spec.function.parameters).toMatchObject({ type: 'object' });
      expect(Object.keys(spec.function.parameters.properties as object).length).toBeGreaterThan(0);
    }
    const calculator = specs.find((spec) => spec.function.name === 'calculator');
    expect(calculator?.function.parameters).toMatchObject({ required: ['expression'] });
  });

  it('should report an unknown tool rather than throwing', async () => {
    const outcome = await runTool(registry.get('nope'), 'nope', {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('unknown-tool');
  });

  it('should report a cancellation distinctly from a timeout', async () => {
    const controller = new AbortController();
    const hanging: AnyTool = {
      ...calculatorTool,
      timeoutMs: 5_000,
      execute: () => new Promise(() => undefined),
    } as unknown as AnyTool;
    const promise = runTool(
      hanging,
      'calculator',
      { expression: '1' },
      { signal: controller.signal },
    );
    controller.abort();
    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.kind).toBe('cancelled');
  });

  it('should always report a duration and give every tool a timeout', async () => {
    const outcome = await runTool(registry.get('calculator'), 'calculator', { expression: '1+1' });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(datetimeTool.timeoutMs).toBeGreaterThan(0);
    for (const tool of ALL_TOOLS) expect(tool.timeoutMs).toBeGreaterThan(0);
  });
});
