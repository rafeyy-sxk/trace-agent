import type { Citation } from './types';

const URL_KEYS = new Set(['url', 'absurl', 'finalurl', 'pdfurl', 'link', 'href', 'page']);
const TITLE_KEYS = ['title', 'name', 'displaytitle', 'heading'] as const;

function isHttpUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith('http://') || value.startsWith('https://')) &&
    value.length < 2048
  );
}

function titleOf(record: Record<string, unknown>, fallback: string): string {
  for (const key of TITLE_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return fallback;
}

/**
 * Pull citations out of whatever a tool actually returned.
 *
 * Walks the typed result rather than asking the model which sources it used.
 * A model asked to list its sources will invent one; a URL that is physically
 * present in a tool result is a URL the tool really returned.
 */
export function citationsFromResult(
  result: unknown,
  tool: string,
  step: number,
  limit = 12,
): Citation[] {
  const found: Citation[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown, depth: number): void => {
    if (found.length >= limit || depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (URL_KEYS.has(key.toLowerCase()) && isHttpUrl(value) && !seen.has(value)) {
        seen.add(value);
        found.push({ url: value, title: titleOf(record, value), tool, step });
        if (found.length >= limit) return;
      }
    }
    for (const value of Object.values(record)) visit(value, depth + 1);
  };

  visit(result, 0);
  return found;
}

/** Merge citations, keeping the first occurrence of each URL. */
export function dedupeCitations(citations: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const citation of citations) {
    if (seen.has(citation.url)) continue;
    seen.add(citation.url);
    out.push(citation);
  }
  return out;
}
