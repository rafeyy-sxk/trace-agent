/**
 * Outbound request guard (SSRF).
 *
 * The agent fetches URLs the model chose, and the model is influenced by text
 * the agent fetched. That is an untrusted-input path straight into our
 * server's network position, so every outbound URL passes through here.
 *
 * Three layers, because any one of them alone is bypassable:
 *   1. shape  — scheme, credentials, hostname suffixes
 *   2. literal — an IP written into the URL, in any of its encodings
 *   3. DNS    — what the hostname actually resolves to right now
 *
 * Redirects are re-validated hop by hop in `http.ts`; a guard that only
 * checks the first URL is not a guard.
 */

import { classifyIp, parseIp, type IpKind } from './ip';

export type RefusalReason =
  | 'malformed-url'
  | 'blocked-scheme'
  | 'embedded-credentials'
  | 'blocked-hostname'
  | 'private-address'
  | 'unresolvable-hostname'
  | 'too-many-redirects';

export class UrlRefusedError extends Error {
  readonly reason: RefusalReason;
  readonly url: string;

  constructor(reason: RefusalReason, url: string, detail: string) {
    super(`Refused to fetch ${url}: ${detail}`);
    this.name = 'UrlRefusedError';
    this.reason = reason;
    this.url = url;
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Hostnames that never denote a public host. Matched exactly or as a suffix
 * after a dot, so `evil-localhost.com` is NOT blocked but `db.localhost` is.
 */
const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home.arpa',
  'in-addr.arpa',
  'ip6.arpa',
  'onion',
] as const;

/** Exact hostnames used by cloud metadata services. */
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export interface DnsResolver {
  /** Resolve a hostname to one or more IP literal strings. */
  (hostname: string): Promise<string[]>;
}

export interface GuardOptions {
  /**
   * Resolver used for layer 3. Injected so tests never touch the network and
   * so a caller can supply a cached resolver.
   */
  readonly resolve?: DnsResolver;
}

export interface GuardedUrl {
  readonly url: URL;
  /** Addresses checked at layer 2/3. Empty when DNS was not consulted. */
  readonly addresses: readonly string[];
  /** True when DNS ran; false means only shape + literal checks applied. */
  readonly dnsChecked: boolean;
}

function normalizeHostname(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function hostnameIsBlocked(host: string): boolean {
  if (host.length === 0) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

const KIND_LABEL: Record<IpKind, string> = {
  public: 'public',
  loopback: 'a loopback address',
  private: 'a private network address',
  'link-local': 'a link-local address',
  unspecified: 'an unspecified address',
  multicast: 'a multicast address',
  reserved: 'a reserved address',
  shared: 'a carrier-grade NAT address',
  'unique-local': 'a unique-local address',
};

/**
 * Layers 1 and 2. Synchronous, no I/O. Exported on its own so that the
 * redirect follower can reject a hop before spending a DNS lookup on it.
 */
export function assertUrlShape(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlRefusedError('malformed-url', rawUrl, 'it is not a valid absolute URL');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlRefusedError(
      'blocked-scheme',
      rawUrl,
      `the "${url.protocol.replace(':', '')}" scheme is not allowed (only http and https)`,
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new UrlRefusedError(
      'embedded-credentials',
      rawUrl,
      'it embeds credentials in the authority',
    );
  }

  const host = normalizeHostname(url.hostname);
  if (hostnameIsBlocked(host)) {
    throw new UrlRefusedError(
      'blocked-hostname',
      rawUrl,
      `"${host}" is not a public hostname`,
    );
  }

  const literal = parseIp(host.startsWith('[') ? host.slice(1, -1) : host);
  if (literal) {
    const kind = classifyIp(literal);
    if (kind !== 'public') {
      throw new UrlRefusedError(
        'private-address',
        rawUrl,
        `${literal.normalized} is ${KIND_LABEL[kind]}`,
      );
    }
  }

  return url;
}

/** Default resolver. Kept lazy so the module stays importable in the browser. */
export const nodeDnsResolver: DnsResolver = async (hostname: string) => {
  const dns = await import('node:dns/promises');
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

/**
 * Full guard. Throws `UrlRefusedError` unless the URL is an http(s) URL whose
 * host resolves exclusively to public unicast addresses.
 */
export async function assertPublicHttpUrl(
  rawUrl: string,
  options: GuardOptions = {},
): Promise<GuardedUrl> {
  const url = assertUrlShape(rawUrl);
  const host = normalizeHostname(url.hostname);

  // An IP literal was already classified by `assertUrlShape`; DNS adds nothing.
  const literal = parseIp(host.startsWith('[') ? host.slice(1, -1) : host);
  if (literal) {
    return { url, addresses: [literal.normalized], dnsChecked: false };
  }

  const resolve = options.resolve ?? nodeDnsResolver;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (error) {
    throw new UrlRefusedError(
      'unresolvable-hostname',
      rawUrl,
      `"${host}" did not resolve (${error instanceof Error ? error.message : 'unknown error'})`,
    );
  }

  if (addresses.length === 0) {
    throw new UrlRefusedError(
      'unresolvable-hostname',
      rawUrl,
      `"${host}" resolved to no addresses`,
    );
  }

  for (const address of addresses) {
    const parsed = parseIp(address);
    if (!parsed) {
      throw new UrlRefusedError(
        'private-address',
        rawUrl,
        `"${host}" resolved to an unparseable address (${address})`,
      );
    }
    const kind = classifyIp(parsed);
    if (kind !== 'public') {
      throw new UrlRefusedError(
        'private-address',
        rawUrl,
        `"${host}" resolves to ${parsed.normalized}, which is ${KIND_LABEL[kind]}`,
      );
    }
  }

  return { url, addresses, dnsChecked: true };
}
