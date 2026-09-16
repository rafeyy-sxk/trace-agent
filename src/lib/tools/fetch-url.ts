import { z } from 'zod/v4';
import { safeFetch } from '../net/http';
import { htmlToReadableText } from '../text/html';
import type { Tool } from './types';

export const fetchUrlSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .describe('An absolute http:// or https:// URL to a public web page.'),
  max_chars: z
    .number()
    .int()
    .min(200)
    .max(20_000)
    .optional()
    .describe('How much readable text to return. Defaults to 6000.'),
});

export type FetchUrlArgs = z.infer<typeof fetchUrlSchema>;

export interface FetchUrlResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly text: string;
  readonly charCount: number;
  readonly truncated: boolean;
  readonly redirectChain: readonly string[];
}

const TEXTUAL_CONTENT = /^(text\/|application\/(json|xml|xhtml|rss|atom|ld\+json))/i;

export const fetchUrlTool: Tool<FetchUrlArgs, FetchUrlResult> = {
  name: 'fetch_url',
  title: 'Fetch URL',
  description:
    'Fetch a public web page and return its readable text with the title. ' +
    'Use this to read a specific page you already have a URL for — a source cited ' +
    'by another tool, a documentation page, a news article. Requests to private ' +
    'networks, localhost and non-http(s) schemes are refused.',
  schema: fetchUrlSchema,
  timeoutMs: 12_000,
  async execute(args, context) {
    const maxChars = args.max_chars ?? 6_000;
    const response = await safeFetch(args.url, {
      timeoutMs: 10_000,
      // Read far more than we keep: a large encyclopaedia article is well over
      // a megabyte of markup, and the readable prose is spread through all of
      // it. Only `maxChars` of extracted text is ever handed to the model.
      maxBytes: Math.max(2 * 1024 * 1024, maxChars * 8),
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
      ...(context.resolve ? { resolve: context.resolve } : {}),
    });

    const isTextual = response.contentType === '' || TEXTUAL_CONTENT.test(response.contentType);
    if (!isTextual) {
      return {
        requestedUrl: args.url,
        finalUrl: response.finalUrl,
        status: response.status,
        contentType: response.contentType,
        title: null,
        description: null,
        text: `[no readable text: the server returned ${response.contentType}]`,
        charCount: 0,
        truncated: false,
        redirectChain: response.redirectChain,
      };
    }

    const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(response.body.slice(0, 2_000));
    const extracted = looksLikeHtml
      ? htmlToReadableText(response.body, { maxChars })
      : { title: null, description: null, text: response.body.slice(0, maxChars), paragraphs: [] };

    return {
      requestedUrl: args.url,
      finalUrl: response.finalUrl,
      status: response.status,
      contentType: response.contentType,
      title: extracted.title,
      description: extracted.description,
      text: extracted.text,
      charCount: extracted.text.length,
      truncated: response.truncated || extracted.text.length >= maxChars,
      redirectChain: response.redirectChain,
    };
  },
  observe(result) {
    const header = [
      `URL: ${result.finalUrl}`,
      `HTTP ${result.status}`,
      result.title ? `Title: ${result.title}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
    const suffix = result.truncated ? '\n[truncated]' : '';
    return `${header}\n\n${result.text}${suffix}`;
  },
};
