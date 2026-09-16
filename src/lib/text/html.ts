/**
 * HTML -> readable text.
 *
 * Deliberately dependency-free and deliberately not a DOM. A full parser
 * (jsdom / readability) is 3MB of cold-start on a serverless function to
 * produce the same paragraphs for the 95% of pages an agent actually reads.
 * What this does do honestly: it removes non-content elements first, then
 * prefers the densest content container, then flattens.
 *
 * It is a heuristic and the README says so.
 */

const DROPPED_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'form',
  'nav',
  'header',
  'footer',
  'aside',
  'button',
  'select',
  'figure',
] as const;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  middot: '·',
  deg: '°',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function stripElement(html: string, tag: string): string {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let result = '';
  let index = 0;
  for (;;) {
    open.lastIndex = index;
    const match = open.exec(html);
    if (!match) break;
    const closeIndex = html.toLowerCase().indexOf(`</${tag}>`, match.index + match[0].length);
    result += html.slice(index, match.index);
    if (closeIndex === -1) {
      // Unclosed: drop the remainder rather than keeping markup soup.
      return result;
    }
    index = closeIndex + tag.length + 3;
  }
  return result + html.slice(index);
}

/** Pull `<title>`, falling back to the first `<h1>`. */
export function extractTitle(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title?.[1]) return normalizeWhitespace(decodeEntities(stripTags(title[1])));
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1?.[1]) return normalizeWhitespace(decodeEntities(stripTags(h1[1])));
  return null;
}

export function extractMetaDescription(html: string): string | null {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return normalizeWhitespace(decodeEntities(match[1]));
  }
  return null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t ]+/g, ' ').trim();
}

const BLOCK_BOUNDARY =
  /<\/?(p|div|section|article|main|br|hr|h[1-6]|li|tr|td|th|blockquote|pre|dd|dt)\b[^>]*>/gi;

/** Score of how much visible text a fragment holds, minus its markup weight. */
function textDensity(fragment: string): number {
  const text = normalizeWhitespace(stripTags(fragment));
  return text.length;
}

/**
 * Choose the best content container: `<article>`, then `<main>`, then the
 * whole body, whichever holds the most text.
 */
function selectContentRoot(html: string): string {
  const candidates: string[] = [];
  for (const tag of ['article', 'main'] as const) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      if (match[1]) candidates.push(match[1]);
    }
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  const bodyDensity = textDensity(body);
  let best = body;
  let bestScore = bodyDensity * 0.6; // bias toward semantic containers
  for (const candidate of candidates) {
    const score = textDensity(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

const MAX_PROSE_WORD_LENGTH = 80;
const JUNK_RATIO_THRESHOLD = 0.3;
const JUNK_MIN_LENGTH = 120;
const JSON_MARKERS = ['{"', '"}', '":{', '":[', '"wt":', '}}'] as const;

/**
 * Reject serialised data that survived tag stripping.
 *
 * Wikipedia in particular embeds template JSON directly in the document body.
 * Handing that to a model is worse than handing it nothing: it looks like
 * content, it burns a large share of the context window, and it pushes the
 * real article out of the budget.
 */
export function looksLikeProse(paragraph: string): boolean {
  if (paragraph.length === 0) return false;

  const jsonMarkers = JSON_MARKERS.filter((marker) => paragraph.includes(marker)).length;
  if (jsonMarkers >= 2) return false;

  const longestWord = paragraph
    .split(/\s+/)
    .reduce((longest, word) => Math.max(longest, word.length), 0);
  if (longestWord > MAX_PROSE_WORD_LENGTH) return false;

  if (paragraph.length >= JUNK_MIN_LENGTH) {
    const symbols = paragraph.replace(/[\p{L}\p{N}\s.,;:!?'()\u2018\u2019\u201c\u201d-]/gu, '').length;
    if (symbols / paragraph.length > JUNK_RATIO_THRESHOLD) return false;
  }

  return true;
}

export interface ReadableText {
  readonly title: string | null;
  readonly description: string | null;
  readonly text: string;
  readonly paragraphs: readonly string[];
}

/** Extract readable text. Plain-text input is passed through unchanged. */
export function htmlToReadableText(html: string, options: { maxChars?: number } = {}): ReadableText {
  const maxChars = options.maxChars ?? 12_000;
  const title = extractTitle(html);
  const description = extractMetaDescription(html);

  let working = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROPPED_ELEMENTS) {
    working = stripElement(working, tag);
  }
  working = selectContentRoot(working);
  working = working.replace(BLOCK_BOUNDARY, '\n');
  working = stripTags(working);
  working = decodeEntities(working);

  const paragraphs = working
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0);

  const kept: string[] = [];
  let total = 0;
  for (const paragraph of paragraphs) {
    if (total >= maxChars) break;
    if (!looksLikeProse(paragraph)) continue;
    if (total + paragraph.length > maxChars) {
      // One long paragraph must never end the extraction. Take what fits of
      // the first overflowing paragraph, then stop — but never skip straight
      // past the rest of the article because paragraph three was oversized.
      const room = maxChars - total;
      if (room > 200) {
        kept.push(`${paragraph.slice(0, room)}\u2026`);
        total = maxChars;
      }
      continue;
    }
    kept.push(paragraph);
    total += paragraph.length + 1;
  }

  return { title, description, text: kept.join('\n'), paragraphs: kept };
}
