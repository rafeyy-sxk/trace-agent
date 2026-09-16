/**
 * IP address parsing and classification.
 *
 * This exists so the SSRF guard can decide, from an address alone, whether a
 * request would leave the public internet. It deliberately does not use any
 * dependency: the range table is the security boundary and needs to be
 * readable in a review.
 */

export type IpKind =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'unspecified'
  | 'multicast'
  | 'reserved'
  | 'shared'
  | 'unique-local';

export type IpVersion = 4 | 6;

export interface ParsedIp {
  readonly version: IpVersion;
  /** Big-endian bytes: 4 for IPv4, 16 for IPv6. */
  readonly bytes: readonly number[];
  readonly normalized: string;
}

const IPV4_DECIMAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Parse a strict dotted-quad IPv4 address. Rejects everything else. */
export function parseIpv4(input: string): ParsedIp | null {
  const match = IPV4_DECIMAL.exec(input);
  if (!match) return null;
  const bytes: number[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const raw = match[i] as string;
    // Reject leading zeros: "0177.0.0.1" is octal in some resolvers.
    if (raw.length > 1 && raw.startsWith('0')) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes.push(value);
  }
  return { version: 4, bytes, normalized: bytes.join('.') };
}

/** Parse an IPv6 address, including the `::` compressed form and IPv4 tails. */
export function parseIpv6(input: string): ParsedIp | null {
  let text = input;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // A zone id (fe80::1%eth0) never denotes a public address.
  const zoneIndex = text.indexOf('%');
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);
  if (text.length === 0 || !text.includes(':')) return null;

  const doubleColonCount = text.split('::').length - 1;
  if (doubleColonCount > 1) return null;

  const [headText = '', tailText = ''] =
    doubleColonCount === 1 ? (text.split('::') as [string, string]) : [text, ''];

  const readGroups = (segment: string, allowIpv4Tail: boolean): number[] | null => {
    if (segment === '') return [];
    const parts = segment.split(':');
    const out: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] as string;
      const isLast = i === parts.length - 1;
      if (isLast && allowIpv4Tail && part.includes('.')) {
        const v4 = parseIpv4(part);
        if (!v4) return null;
        out.push(((v4.bytes[0] as number) << 8) | (v4.bytes[1] as number));
        out.push(((v4.bytes[2] as number) << 8) | (v4.bytes[3] as number));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };

  const head = readGroups(headText, doubleColonCount === 0);
  const tail = doubleColonCount === 1 ? readGroups(tailText, true) : [];
  if (head === null || tail === null) return null;

  let groups: number[];
  if (doubleColonCount === 1) {
    const fillCount = 8 - head.length - tail.length;
    if (fillCount < 1) return null;
    groups = [...head, ...new Array<number>(fillCount).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return {
    version: 6,
    bytes,
    normalized: groups.map((g) => g.toString(16)).join(':'),
  };
}

/** Parse either family. Returns null when the string is not an IP literal. */
export function parseIp(input: string): ParsedIp | null {
  const trimmed = input.trim();
  return parseIpv4(trimmed) ?? parseIpv6(trimmed);
}

interface Cidr {
  readonly bytes: readonly number[];
  readonly prefix: number;
  readonly kind: IpKind;
}

const toV4 = (a: number, b: number, c: number, d: number, prefix: number, kind: IpKind): Cidr => ({
  bytes: [a, b, c, d],
  prefix,
  kind,
});

/** IPv4 ranges that are not reachable public unicast space. */
const IPV4_RANGES: readonly Cidr[] = [
  toV4(0, 0, 0, 0, 8, 'unspecified'), //        "this network"
  toV4(10, 0, 0, 0, 8, 'private'), //           RFC1918
  toV4(100, 64, 0, 0, 10, 'shared'), //         RFC6598 carrier NAT
  toV4(127, 0, 0, 0, 8, 'loopback'), //         loopback
  toV4(169, 254, 0, 0, 16, 'link-local'), //    link-local, incl. cloud metadata
  toV4(172, 16, 0, 0, 12, 'private'), //        RFC1918
  toV4(192, 0, 0, 0, 24, 'reserved'), //        IETF protocol assignments
  toV4(192, 0, 2, 0, 24, 'reserved'), //        TEST-NET-1
  toV4(192, 88, 99, 0, 24, 'reserved'), //      6to4 relay anycast
  toV4(192, 168, 0, 0, 16, 'private'), //       RFC1918
  toV4(198, 18, 0, 0, 15, 'reserved'), //       benchmarking
  toV4(198, 51, 100, 0, 24, 'reserved'), //     TEST-NET-2
  toV4(203, 0, 113, 0, 24, 'reserved'), //      TEST-NET-3
  toV4(224, 0, 0, 0, 4, 'multicast'), //        multicast
  toV4(240, 0, 0, 0, 4, 'reserved'), //         future use + broadcast
];

const IPV6_RANGES: readonly Cidr[] = [
  { bytes: new Array<number>(16).fill(0), prefix: 128, kind: 'unspecified' },
  { bytes: [...new Array<number>(15).fill(0), 1], prefix: 128, kind: 'loopback' },
  { bytes: [0x01, ...new Array<number>(15).fill(0)], prefix: 8, kind: 'reserved' }, // 100::/8 discard
  { bytes: [0xfc, ...new Array<number>(15).fill(0)], prefix: 7, kind: 'unique-local' },
  { bytes: [0xfe, 0x80, ...new Array<number>(14).fill(0)], prefix: 10, kind: 'link-local' },
  { bytes: [0xff, ...new Array<number>(15).fill(0)], prefix: 8, kind: 'multicast' },
];

function inRange(bytes: readonly number[], range: Cidr): boolean {
  let remaining = range.prefix;
  for (let i = 0; i < range.bytes.length && remaining > 0; i += 1) {
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if (((bytes[i] as number) & mask) !== ((range.bytes[i] as number) & mask)) return false;
    remaining -= take;
  }
  return true;
}

const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff] as const;
const NAT64_PREFIX = [0x00, 0x64, 0xff, 0x9b] as const;

/**
 * Extract an embedded IPv4 address from IPv4-mapped (::ffff:a.b.c.d),
 * NAT64 (64:ff9b::/96) and 6to4 (2002::/16) IPv6 addresses. These are the
 * standard ways to smuggle 127.0.0.1 past a naive v6 check.
 */
export function embeddedIpv4(ip: ParsedIp): ParsedIp | null {
  if (ip.version !== 6) return null;
  const b = ip.bytes;
  const startsWith = (prefix: readonly number[]): boolean =>
    prefix.every((value, index) => b[index] === value);

  if (startsWith(V4_MAPPED_PREFIX)) {
    const bytes = b.slice(12, 16);
    return { version: 4, bytes, normalized: bytes.join('.') };
  }
  if (startsWith(NAT64_PREFIX) && b.slice(4, 12).every((v) => v === 0)) {
    const bytes = b.slice(12, 16);
    return { version: 4, bytes, normalized: bytes.join('.') };
  }
  if (b[0] === 0x20 && b[1] === 0x02) {
    const bytes = b.slice(2, 6);
    return { version: 4, bytes, normalized: bytes.join('.') };
  }
  return null;
}

/** Classify an address. `public` is the only value the SSRF guard allows. */
export function classifyIp(ip: ParsedIp): IpKind {
  if (ip.version === 6) {
    const embedded = embeddedIpv4(ip);
    if (embedded) {
      const inner = classifyIp(embedded);
      // A 6to4/NAT64/mapped wrapper is never more public than its payload.
      if (inner !== 'public') return inner;
    }
    for (const range of IPV6_RANGES) {
      if (inRange(ip.bytes, range)) return range.kind;
    }
    return 'public';
  }
  for (const range of IPV4_RANGES) {
    if (inRange(ip.bytes, range)) return range.kind;
  }
  return 'public';
}

/** Convenience: is this literal safe to send an outbound request to? */
export function isPublicIpLiteral(input: string): boolean {
  const parsed = parseIp(input);
  if (!parsed) return false;
  return classifyIp(parsed) === 'public';
}
