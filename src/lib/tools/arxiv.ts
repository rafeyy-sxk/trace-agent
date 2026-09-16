import { z } from 'zod/v4';
import { safeFetch } from '../net/http';
import { allTagText, entries, firstTagText, links } from '../text/atom';
import type { Tool } from './types';

export const arxivSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(300)
    .describe('Search terms, e.g. "speculative decoding" or "author:Hinton dropout".'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(15)
    .optional()
    .describe('How many papers to return. Defaults to 5.'),
  sort_by: z
    .enum(['relevance', 'lastUpdatedDate', 'submittedDate'])
    .optional()
    .describe('Ordering. Defaults to relevance.'),
});

export type ArxivArgs = z.infer<typeof arxivSchema>;

export interface ArxivPaper {
  readonly id: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly summary: string;
  readonly published: string | null;
  readonly updated: string | null;
  readonly categories: readonly string[];
  readonly absUrl: string;
  readonly pdfUrl: string | null;
}

export interface ArxivResult {
  readonly query: string;
  readonly totalResults: number;
  readonly papers: readonly ArxivPaper[];
}

export class ArxivError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArxivError';
  }
}

const ARXIV_ENDPOINT = 'https://export.arxiv.org/api/query';

/** Pass a fielded query (`au:`, `ti:`, `cat:`) through; otherwise search all fields. */
function buildSearchQuery(raw: string): string {
  const trimmed = raw.trim();
  if (/\b(all|ti|au|abs|co|jr|cat|rn|id):/i.test(trimmed)) return trimmed;
  return `all:${trimmed}`;
}

export function parseArxivFeed(xml: string, query: string): ArxivResult {
  const totalRaw = firstTagText(xml, 'opensearch:totalResults');
  const totalResults = totalRaw ? Number.parseInt(totalRaw, 10) : 0;

  const papers: ArxivPaper[] = [];
  for (const entry of entries(xml)) {
    const absId = firstTagText(entry, 'id');
    const title = firstTagText(entry, 'title');
    if (!absId || !title) continue;
    const entryLinks = links(entry);
    const pdf = entryLinks.find((link) => link.title === 'pdf')?.href ?? null;
    const categories = (entry.match(/<category\b[^>]*term=["']([^"']+)["']/gi) ?? [])
      .map((tag) => /term=["']([^"']+)["']/i.exec(tag)?.[1] ?? '')
      .filter((term) => term.length > 0);

    papers.push({
      id: absId.replace(/^https?:\/\/arxiv\.org\/abs\//, ''),
      title,
      authors: allTagText(entry, 'name'),
      summary: firstTagText(entry, 'summary') ?? '',
      published: firstTagText(entry, 'published'),
      updated: firstTagText(entry, 'updated'),
      categories,
      absUrl: absId.replace(/^http:/, 'https:'),
      pdfUrl: pdf,
    });
  }

  return { query, totalResults: Number.isFinite(totalResults) ? totalResults : 0, papers };
}

export const arxivTool: Tool<ArxivArgs, ArxivResult> = {
  name: 'arxiv_search',
  title: 'arXiv',
  description:
    'Search arXiv for scientific preprints and return titles, authors, abstracts ' +
    'and links. Use this for research questions, machine-learning methods, physics, ' +
    'maths and anything where the primary source is a paper rather than an encyclopaedia.',
  schema: arxivSchema,
  timeoutMs: 15_000,
  async execute(args, context) {
    const url = new URL(ARXIV_ENDPOINT);
    url.searchParams.set('search_query', buildSearchQuery(args.query));
    url.searchParams.set('start', '0');
    url.searchParams.set('max_results', String(args.max_results ?? 5));
    if (args.sort_by) url.searchParams.set('sortBy', args.sort_by);

    const response = await safeFetch(url.toString(), {
      timeoutMs: 12_000,
      maxBytes: 512 * 1024,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
      ...(context.resolve ? { resolve: context.resolve } : {}),
    });

    if (response.status !== 200) {
      throw new ArxivError(`arXiv returned HTTP ${response.status}`);
    }
    if (!response.body.includes('<feed')) {
      throw new ArxivError('arXiv returned a response that is not an Atom feed');
    }
    return parseArxivFeed(response.body, args.query);
  },
  observe(result) {
    if (result.papers.length === 0) {
      return `No arXiv papers matched "${result.query}".`;
    }
    const lines = [`${result.totalResults} arXiv matches for "${result.query}". Top results:`];
    for (const paper of result.papers) {
      const authors =
        paper.authors.length > 3
          ? `${paper.authors.slice(0, 3).join(', ')} et al.`
          : paper.authors.join(', ');
      lines.push(
        '',
        `[${paper.id}] ${paper.title}`,
        `  Authors: ${authors || 'unknown'}`,
        `  Published: ${paper.published ?? 'unknown'} | Categories: ${paper.categories.join(', ') || 'n/a'}`,
        `  URL: ${paper.absUrl}`,
        `  Abstract: ${paper.summary.slice(0, 600)}${paper.summary.length > 600 ? '…' : ''}`,
      );
    }
    return lines.join('\n');
  },
};
