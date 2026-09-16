import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { decodeEntities, extractTitle, htmlToReadableText } from './html';

/**
 * A real 1.9MB Wikipedia page, saved during live verification. These two
 * regressions were both found by running the agent for real, not by reading
 * the code: the page came back as 377 characters of navigation chrome.
 */
const FIXTURE = new URL('./__fixtures__/wikipedia-tokyo.html', import.meta.url).pathname;

describe('entity decoding', () => {
  it('should decode named, decimal and hex entities', () => {
    expect(decodeEntities('a &amp; b &#65; c &#x42; d &nbsp;e')).toBe('a & b A c B d  e');
  });

  it('should leave an unknown entity untouched rather than mangling it', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
  });
});

describe('title extraction', () => {
  it('should prefer the title element and fall back to the first h1', () => {
    expect(extractTitle('<html><head><title>A &amp; B</title></head></html>')).toBe('A & B');
    expect(extractTitle('<html><body><h1>Only an H1</h1></body></html>')).toBe('Only an H1');
    expect(extractTitle('<html><body><p>no title</p></body></html>')).toBeNull();
  });
});

describe('readable text extraction', () => {
  it('should drop non-content elements and keep the article', () => {
    const out = htmlToReadableText(
      '<html><body><nav>navigation</nav><script>evil()</script>' +
        '<article><p>The real content is here.</p></article>' +
        '<footer>footer junk</footer></body></html>',
    );
    expect(out.text).toContain('The real content is here.');
    expect(out.text).not.toContain('navigation');
    expect(out.text).not.toContain('evil()');
    expect(out.text).not.toContain('footer junk');
  });

  it('should not let one oversized junk paragraph end the extraction', () => {
    const junk = `{"wt":"${'x'.repeat(4_000)}"}`;
    const html =
      '<html><body><article>' +
      '<p>First real sentence.</p>' +
      `<p>${junk}</p>` +
      '<p>Second real sentence that must survive.</p>' +
      '<p>Third real sentence that must also survive.</p>' +
      '</article></body></html>';

    const out = htmlToReadableText(html, { maxChars: 2_000 });
    expect(out.text).toContain('First real sentence.');
    expect(out.text).toContain('Second real sentence that must survive.');
    expect(out.text).toContain('Third real sentence that must also survive.');
  });

  it('should drop serialised data blobs that are not prose', () => {
    const blob = `{"image_map":{"wt":"{{maplink|frame=yes|${'a'.repeat(300)}"}}`;
    const out = htmlToReadableText(
      `<html><body><article><p>Readable prose about a city.</p><p>${blob}</p></article></body></html>`,
      { maxChars: 5_000 },
    );
    expect(out.text).toContain('Readable prose about a city.');
    expect(out.text).not.toContain('image_map');
  });

  it('should pass plain text through unchanged', () => {
    const out = htmlToReadableText('just some plain text, no markup', { maxChars: 500 });
    expect(out.text).toContain('just some plain text');
  });
});

describe('a real Wikipedia page', () => {
  const available = existsSync(FIXTURE);
  const maybe = available ? it : it.skip;

  maybe('should extract the article body, not the navigation chrome', () => {
    const html = readFileSync(FIXTURE, 'utf8');
    const out = htmlToReadableText(html, { maxChars: 6_000 });

    // The live-run failure: 377 characters, all of it site chrome.
    expect(out.text.length).toBeGreaterThan(3_000);
    expect(out.text).toMatch(/capital|Japan|population/i);
    expect(out.title).toBe('Tokyo - Wikipedia');
  });

  maybe('should still reach the article even when the fetch layer truncated the page', () => {
    // The live failure looked like a byte-cap problem. It was not: the cap only
    // mattered because a single embedded JSON blob was consuming the character
    // budget before the prose was reached. With the blob filtered out, even the
    // first 256KB of the page yields real article text.
    const html = readFileSync(FIXTURE, 'utf8').slice(0, 262_144);
    const out = htmlToReadableText(html, { maxChars: 6_000 });
    expect(out.text.length).toBeGreaterThan(3_000);
    expect(out.text).toMatch(/capital|Japan/i);
  });

  maybe('should never emit a serialised template blob into the model context', () => {
    const html = readFileSync(FIXTURE, 'utf8');
    const out = htmlToReadableText(html, { maxChars: 12_000 });
    expect(out.text).not.toContain('"wt":');
    expect(out.text).not.toContain('image_map');
  });
});
