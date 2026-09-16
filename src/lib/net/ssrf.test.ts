import { describe, expect, it } from 'vitest';
import { classifyIp, parseIp, parseIpv4, parseIpv6 } from './ip';
import { assertPublicHttpUrl, assertUrlShape, UrlRefusedError, type DnsResolver } from './ssrf';

const publicResolver: DnsResolver = async () => ['93.184.216.34'];
const privateResolver: DnsResolver = async () => ['10.1.2.3'];

async function refusal(url: string, resolve: DnsResolver = publicResolver): Promise<UrlRefusedError> {
  try {
    await assertPublicHttpUrl(url, { resolve });
  } catch (error) {
    if (error instanceof UrlRefusedError) return error;
    throw error;
  }
  throw new Error(`Expected ${url} to be refused, but it was allowed`);
}

describe('IP parsing and classification', () => {
  it('should reject octal-looking IPv4 quads that resolvers read differently', () => {
    expect(parseIpv4('0177.0.0.1')).toBeNull();
    expect(parseIpv4('127.0.0.1')).not.toBeNull();
  });

  it('should classify the cloud metadata address as link-local', () => {
    const parsed = parseIp('169.254.169.254');
    expect(parsed).not.toBeNull();
    expect(classifyIp(parsed!)).toBe('link-local');
  });

  it('should unwrap an IPv4-mapped IPv6 address and classify the payload', () => {
    const parsed = parseIpv6('::ffff:127.0.0.1');
    expect(parsed).not.toBeNull();
    expect(classifyIp(parsed!)).toBe('loopback');
  });

  it('should treat a public address as public', () => {
    expect(classifyIp(parseIp('93.184.216.34')!)).toBe('public');
    expect(classifyIp(parseIp('2606:2800:220:1:248:1893:25c8:1946')!)).toBe('public');
  });
});

describe('SSRF guard — the refusals the brief requires', () => {
  it('should refuse http://127.0.0.1:8080', async () => {
    const error = await refusal('http://127.0.0.1:8080');
    expect(error.reason).toBe('private-address');
    expect(error.message).toContain('loopback');
  });

  it('should refuse file:///etc/passwd', async () => {
    const error = await refusal('file:///etc/passwd');
    expect(error.reason).toBe('blocked-scheme');
    expect(error.message).toContain('file');
  });
});

describe('SSRF guard — the rest of the class', () => {
  it.each([
    ['http://localhost:3000/admin', 'blocked-hostname'],
    ['http://db.localhost/', 'blocked-hostname'],
    ['http://printer.local/', 'blocked-hostname'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'blocked-hostname'],
    ['http://169.254.169.254/latest/meta-data/', 'private-address'],
    ['http://10.0.0.5/', 'private-address'],
    ['http://192.168.1.1/', 'private-address'],
    ['http://172.16.9.9/', 'private-address'],
    ['http://[::1]:5432/', 'private-address'],
    ['http://[::ffff:127.0.0.1]/', 'private-address'],
    ['http://0.0.0.0/', 'private-address'],
    ['http://2130706433/', 'private-address'],
    ['http://0x7f000001/', 'private-address'],
    ['ftp://example.com/x', 'blocked-scheme'],
    ['gopher://example.com/', 'blocked-scheme'],
    ['data:text/html,<script>alert(1)</script>', 'blocked-scheme'],
    ['javascript:alert(1)', 'blocked-scheme'],
    ['not a url at all', 'malformed-url'],
    ['http://user:secret@example.com/', 'embedded-credentials'],
  ])('should refuse %s with reason %s', async (url, reason) => {
    const error = await refusal(url);
    expect(error.reason).toBe(reason);
  });

  it('should allow a genuinely public URL — the positive control for every refusal above', async () => {
    const guarded = await assertPublicHttpUrl('https://en.wikipedia.org/wiki/Tokyo', {
      resolve: publicResolver,
    });
    expect(guarded.url.host).toBe('en.wikipedia.org');
    expect(guarded.dnsChecked).toBe(true);
    expect(guarded.addresses).toEqual(['93.184.216.34']);
  });

  it('should not refuse a hostname that merely contains a blocked word', () => {
    expect(() => assertUrlShape('https://evil-localhost.com/')).not.toThrow();
    expect(() => assertUrlShape('https://mylocal.example.com/')).not.toThrow();
  });

  it('should refuse a public hostname that resolves to a private address', async () => {
    const error = await refusal('https://rebind.example.com/', privateResolver);
    expect(error.reason).toBe('private-address');
    expect(error.message).toContain('10.1.2.3');
  });

  it('should refuse when any one of several resolved addresses is private', async () => {
    const mixed: DnsResolver = async () => ['93.184.216.34', '127.0.0.1'];
    const error = await refusal('https://mixed.example.com/', mixed);
    expect(error.reason).toBe('private-address');
  });

  it('should refuse a hostname that does not resolve', async () => {
    const failing: DnsResolver = async () => {
      throw new Error('ENOTFOUND');
    };
    const error = await refusal('https://nope.example.com/', failing);
    expect(error.reason).toBe('unresolvable-hostname');
  });

  it('should not spend a DNS lookup on an IP literal', async () => {
    let called = 0;
    const counting: DnsResolver = async () => {
      called += 1;
      return ['93.184.216.34'];
    };
    const guarded = await assertPublicHttpUrl('https://93.184.216.34/', { resolve: counting });
    expect(called).toBe(0);
    expect(guarded.dnsChecked).toBe(false);
  });
});
