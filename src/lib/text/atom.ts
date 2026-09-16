/**
 * A tolerant reader for the small, well-known Atom feed arXiv returns.
 *
 * Not a general XML parser and not presented as one: it pulls named child
 * elements out of `<entry>` blocks. arXiv's feed is machine-generated and
 * stable, and shipping a full XML parser to a serverless function to read
 * six fields is not a trade worth making.
 */

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
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
    return XML_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Text content of the first `<tag>` inside `xml`, whitespace-collapsed. */
export function firstTagText(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = pattern.exec(xml);
  if (!match || match[1] === undefined) return null;
  return decodeXmlEntities(match[1]).replace(/\s+/g, ' ').trim();
}

/** Text content of every `<tag>` inside `xml`. */
export function allTagText(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    if (match[1] !== undefined) {
      out.push(decodeXmlEntities(match[1]).replace(/\s+/g, ' ').trim());
    }
  }
  return out;
}

/** Every `<entry>...</entry>` block, inner XML included. */
export function entries(xml: string): string[] {
  return allRawBlocks(xml, 'entry');
}

export function allRawBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

export interface AtomLink {
  readonly href: string;
  readonly rel: string | null;
  readonly type: string | null;
  readonly title: string | null;
}

/** Parse `<link .../>` attributes out of a fragment. */
export function links(xml: string): AtomLink[] {
  const pattern = /<link\b([^>]*)\/?>/gi;
  const out: AtomLink[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const attributes = match[1] ?? '';
    const attribute = (name: string): string | null => {
      const found = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attributes);
      return found?.[1] ? decodeXmlEntities(found[1]) : null;
    };
    const href = attribute('href');
    if (!href) continue;
    out.push({
      href,
      rel: attribute('rel'),
      type: attribute('type'),
      title: attribute('title'),
    });
  }
  return out;
}
