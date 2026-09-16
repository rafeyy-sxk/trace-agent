import { z } from 'zod/v4';
import { safeFetch } from '../net/http';
import { decodeEntities } from '../text/html';
import type { Tool } from './types';

/**
 * Wikipedia search + summary in one call.
 *
 * Two endpoints, both keyless: the MediaWiki action API for search, then the
 * REST summary endpoint for the top hit. The agent almost always wants both,
 * and a single tool halves the number of model round trips — which matters a
 * great deal when the token budget is the bottleneck.
 */

export const wikipediaSchema = z.object({
  query: z.string().min(1).max(300).describe('What to search Wikipedia for.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('How many search results to return. Defaults to 4.'),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[a-z]{2,8})?$/i, 'must be a language code such as "en" or "pt-br"')
    .optional()
    .describe('Wikipedia language edition. Defaults to "en".'),
});

export type WikipediaArgs = z.infer<typeof wikipediaSchema>;

export interface WikipediaHit {
  readonly title: string;
  readonly snippet: string;
  readonly pageId: number;
  readonly url: string;
}

export interface WikipediaResult {
  readonly query: string;
  readonly language: string;
  readonly totalHits: number;
  readonly hits: readonly WikipediaHit[];
  readonly summary: {
    readonly title: string;
    readonly description: string | null;
    readonly extract: string;
    readonly url: string;
  } | null;
}

export class WikipediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikipediaError';
  }
}

interface SearchResponse {
  query?: {
    searchinfo?: { totalhits?: number };
    search?: Array<{ title?: string; snippet?: string; pageid?: number }>;
  };
}

interface SummaryResponse {
  title?: string;
  description?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}

function parseJson<T>(body: string, what: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new WikipediaError(`Wikipedia returned a non-JSON ${what} response`);
  }
}

export const wikipediaTool: Tool<WikipediaArgs, WikipediaResult> = {
  name: 'wikipedia',
  title: 'Wikipedia',
  description:
    'Search Wikipedia and get the lead summary of the best-matching article. ' +
    'Use this first for encyclopaedic facts — places, people, organisations, ' +
    'historical events, populations, definitions. Returns article URLs you can cite.',
  schema: wikipediaSchema,
  timeoutMs: 12_000,
  async execute(args, context) {
    const language = (args.language ?? 'en').toLowerCase();
    const limit = args.limit ?? 4;
    const host = `https://${language}.wikipedia.org`;
    const shared = {
      timeoutMs: 8_000,
      maxBytes: 256 * 1024,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
      ...(context.resolve ? { resolve: context.resolve } : {}),
    };

    const searchUrl = new URL(`${host}/w/api.php`);
    searchUrl.searchParams.set('action', 'query');
    searchUrl.searchParams.set('list', 'search');
    searchUrl.searchParams.set('srsearch', args.query);
    searchUrl.searchParams.set('srlimit', String(limit));
    searchUrl.searchParams.set('format', 'json');

    const searchResponse = await safeFetch(searchUrl.toString(), shared);
    if (searchResponse.status !== 200) {
      throw new WikipediaError(`Wikipedia search returned HTTP ${searchResponse.status}`);
    }
    const search = parseJson<SearchResponse>(searchResponse.body, 'search');
    const rawHits = search.query?.search ?? [];

    const hits: WikipediaHit[] = rawHits
      .filter((hit): hit is { title: string; snippet?: string; pageid?: number } =>
        typeof hit.title === 'string',
      )
      .map((hit) => ({
        title: hit.title,
        snippet: decodeEntities((hit.snippet ?? '').replace(/<[^>]*>/g, '')).trim(),
        pageId: hit.pageid ?? -1,
        url: `${host}/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
      }));

    const top = hits[0];
    if (!top) {
      return { query: args.query, language, totalHits: 0, hits: [], summary: null };
    }

    const summaryUrl = `${host}/api/rest_v1/page/summary/${encodeURIComponent(
      top.title.replace(/ /g, '_'),
    )}`;
    const summaryResponse = await safeFetch(summaryUrl, shared);
    let summary: WikipediaResult['summary'] = null;
    if (summaryResponse.status === 200) {
      const parsed = parseJson<SummaryResponse>(summaryResponse.body, 'summary');
      if (parsed.extract) {
        summary = {
          title: parsed.title ?? top.title,
          description: parsed.description ?? null,
          extract: parsed.extract,
          url: parsed.content_urls?.desktop?.page ?? top.url,
        };
      }
    }

    return {
      query: args.query,
      language,
      totalHits: search.query?.searchinfo?.totalhits ?? hits.length,
      hits,
      summary,
    };
  },
  observe(result) {
    if (result.hits.length === 0) {
      return `No Wikipedia articles matched "${result.query}".`;
    }
    const lines: string[] = [];
    if (result.summary) {
      lines.push(`SUMMARY of "${result.summary.title}" (${result.summary.url})`);
      if (result.summary.description) lines.push(result.summary.description);
      lines.push(result.summary.extract, '');
    }
    lines.push(`OTHER RESULTS (${result.totalHits} total matches):`);
    for (const hit of result.hits.slice(result.summary ? 1 : 0)) {
      lines.push(`- ${hit.title} — ${hit.snippet} (${hit.url})`);
    }
    return lines.join('\n');
  },
};
