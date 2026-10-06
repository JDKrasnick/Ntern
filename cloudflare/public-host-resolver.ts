const DOH_QUERY_TIMEOUT_MS = 8_000;
const DNS_RECORD_TYPE: Readonly<Record<'A' | 'AAAA' | 'TXT', number>> = { A: 1, AAAA: 28, TXT: 16 };

export async function dnsJson(name: string, type: 'A' | 'AAAA' | 'TXT'): Promise<Array<{ type?: number; data?: string }>> {
  const endpoint = new URL('https://cloudflare-dns.com/dns-query');
  endpoint.searchParams.set('name', name); endpoint.searchParams.set('type', type);
  let response: Response;
  try {
    response = await fetch(endpoint, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(DOH_QUERY_TIMEOUT_MS) });
  } catch (error) {
    // A stalled resolver query must fail the probe rather than park a queue
    // consumer invocation until the platform's fifteen-minute limit.
    throw new Error(`DNS verification timed out for ${name} (${type}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error('DNS verification is temporarily unavailable');
  const value = await response.json() as { Answer?: Array<{ type?: number; data?: string }> };
  // A recursive answer carries the whole CNAME chain before the requested
  // records. Keeping the CNAME target (for example `boards.us.example.com.`)
  // would make `assertPublicHttpsUrl` treat a hostname as a non-public IP and
  // reject an otherwise public host, so keep only the requested record type.
  return (value.Answer ?? []).filter((answer) => answer.type === DNS_RECORD_TYPE[type]);
}

export const publicHostResolver = {
  async resolve(hostname: string): Promise<string[]> {
    const [ipv4, ipv6] = await Promise.all([dnsJson(hostname, 'A'), dnsJson(hostname, 'AAAA')]);
    return [...ipv4, ...ipv6].map((answer) => answer.data).filter((value): value is string => Boolean(value));
  },
};

