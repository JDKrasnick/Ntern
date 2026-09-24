export interface HostResolver {
  resolve(hostname: string): Promise<readonly string[]>;
}

export interface ApplicationHostContract {
  host: string;
  includeSubdomains?: boolean;
  pathPrefix?: string;
}

export interface SafeFetchOptions {
  resolver: HostResolver;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  headers?: HeadersInit;
  /**
   * What to do when a body exceeds `maxBodyBytes`. `fail` (the default) rejects
   * the response; `truncate` keeps the bounded prefix and stops reading. Both
   * honour the same hard cap, so truncation is only ever a difference in
   * availability — a caller that needs only the leading bytes of a page should
   * not lose them because the page is large.
   */
  onOversize?: 'fail' | 'truncate';
}

export interface SafeFetchResult {
  url: string;
  status: number;
  headers: Headers;
  body: string;
  /** Every URL the request was validated through, starting with the requested one. */
  redirects: readonly string[];
}

function ipv4Number(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  if (octets.some((part, index) => !/^\d+$/.test(parts[index]!) || part < 0 || part > 255)) return undefined;
  return (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!) >>> 0;
}

function ipv4InCidr(address: number, base: string, prefix: number): boolean {
  const baseNumber = ipv4Number(base)!;
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (address & mask) === (baseNumber & mask);
}

const NON_PUBLIC_IPV4: readonly [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function parseIpv6(value: string): bigint | undefined {
  let address = value.toLowerCase().split('%')[0]!;
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const ipv4 = ipv4Number(address.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === undefined) return undefined;
    address = `${address.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  if ((address.match(/::/g) ?? []).length > 1) return undefined;
  const [leftRaw, rightRaw] = address.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  if (!address.includes('::') && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < (address.includes('::') ? 1 : 0)) return undefined;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return groups.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6InCidr(address: bigint, base: string, prefix: number): boolean {
  const baseNumber = parseIpv6(base)!;
  const shift = BigInt(128 - prefix);
  return (address >> shift) === (baseNumber >> shift);
}

const NON_PUBLIC_IPV6: readonly [string, number][] = [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];

/** True only for ordinary globally routable IPv4/IPv6 literals. */
export function isPublicIpAddress(value: string): boolean {
  const ipv4 = ipv4Number(value);
  if (ipv4 !== undefined) return !NON_PUBLIC_IPV4.some(([base, prefix]) => ipv4InCidr(ipv4, base, prefix));
  const ipv6 = parseIpv6(value);
  if (ipv6 === undefined) return false;
  return !NON_PUBLIC_IPV6.some(([base, prefix]) => ipv6InCidr(ipv6, base, prefix));
}

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '');
}

export async function assertPublicHttpsUrl(value: string | URL, resolver: HostResolver): Promise<URL> {
  let url: URL;
  try { url = value instanceof URL ? new URL(value.href) : new URL(value); } catch { throw new Error('URL is invalid'); }
  if (url.protocol !== 'https:') throw new Error('URL must use HTTPS');
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  if (url.port) throw new Error('URL must use the standard HTTPS port');
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')) {
    throw new Error('URL host is not public');
  }

  const literalV4 = ipv4Number(hostname);
  const literalV6 = parseIpv6(hostname);
  const addresses = literalV4 !== undefined || literalV6 !== undefined ? [hostname] : [...await resolver.resolve(hostname)];
  if (addresses.length === 0) throw new Error('URL host did not resolve');
  if (addresses.some((address) => !isPublicIpAddress(address))) throw new Error('URL host resolves to a non-public address');
  return url;
}

export function applicationUrlMatchesContracts(value: string, contracts: readonly ApplicationHostContract[]): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const hostname = normalizedHostname(url.hostname);
  return contracts.some((contract) => {
    const approvedHost = normalizedHostname(contract.host);
    const hostMatches = hostname === approvedHost || (contract.includeSubdomains === true && hostname.endsWith(`.${approvedHost}`));
    if (!hostMatches) return false;
    if (!contract.pathPrefix) return true;
    const prefix = contract.pathPrefix.startsWith('/') ? contract.pathPrefix : `/${contract.pathPrefix}`;
    return url.pathname === prefix || url.pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  });
}

async function withFetchTimeout<T>(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  handle: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Request timed out'));
    }, timeoutMs);
  });
  try {
    const request = fetcher(url, { ...init, signal: controller.signal }).then(handle);
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

async function readBoundedBytes(response: Response, maxBodyBytes: number, onOversize: 'fail' | 'truncate'): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBodyBytes && onOversize === 'fail') {
    throw new Error('Response body exceeds limit');
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBodyBytes) {
        if (onOversize === 'fail') throw new Error('Response body exceeds limit');
        chunks.push(value.subarray(0, maxBodyBytes - total));
        total = maxBodyBytes;
        break;
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export interface SafeFetchBytesResult {
  url: string;
  status: number;
  headers: Headers;
  body: Uint8Array;
  /** Every URL the request was validated through, starting with the requested one. */
  redirects: readonly string[];
}

/** Fetch bytes while validating every redirect target against DNS, time, redirect, and body limits. */
export async function safeFetchBytes(value: string, options: SafeFetchOptions): Promise<SafeFetchBytesResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  if (timeoutMs <= 0 || maxRedirects < 0 || maxBodyBytes <= 0) throw new Error('Fetch limits must be positive');
  let current = await assertPublicHttpsUrl(value, options.resolver);
  const redirects = [current.href];
  const onOversize = options.onOversize ?? 'fail';

  for (let hops = 0; ; hops += 1) {
    const { response, body } = await withFetchTimeout(
      fetcher,
      current,
      { redirect: 'manual', headers: options.headers },
      timeoutMs,
      async (received) => ({
        response: received,
        body: received.status >= 300 && received.status < 400
          ? undefined
          : await readBoundedBytes(received, maxBodyBytes, onOversize),
      }),
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect is missing a location');
      if (hops >= maxRedirects) throw new Error('Redirect limit exceeded');
      current = await assertPublicHttpsUrl(new URL(location, current), options.resolver);
      redirects.push(current.href);
      continue;
    }
    return { url: current.href, status: response.status, headers: response.headers, body: body ?? new Uint8Array(0), redirects };
  }
}

/** Fetch text while validating every redirect target against DNS, time, redirect, and body limits. */
export async function safeFetchText(value: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const result = await safeFetchBytes(value, options);
  return {
    url: result.url, status: result.status, headers: result.headers,
    body: new TextDecoder().decode(result.body), redirects: result.redirects,
  };
}
