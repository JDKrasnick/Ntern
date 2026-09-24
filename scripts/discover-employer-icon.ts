import { discoverEmployerIcon, verifyEmployerIconAsset } from '../src/employer-icon-discovery.js';

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const company = argument('--company');
const domain = argument('--domain');
if (!company || !domain || process.argv.some((value) => value === '--help')) {
  throw new Error('Usage: tsx scripts/discover-employer-icon.ts --company "Figma" --domain figma.com');
}
if (!/^[a-z0-9.-]+$/iu.test(domain) || domain.includes('..')) throw new Error('domain is invalid');

const response = await fetch(`https://${domain}`, { redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: {
  Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Ntern icon review preview/1.0',
} });
const final = new URL(response.url);
if (final.protocol !== 'https:') throw new Error('final page was not HTTPS');
if (!response.ok) throw new Error(`website returned HTTP ${response.status}`);
const contentType = response.headers.get('content-type') ?? '';
const discovery = contentType.includes('text/html')
  ? discoverEmployerIcon(company, final.href, await response.text())
  : { pageUrl: final.href, verifiedName: false, candidates: [], blockedReason: `website returned ${contentType || 'no content type'}, not HTML` };
const candidates = await Promise.all(discovery.candidates.map(async (candidate) => {
  try {
    const asset = await fetch(candidate.assetUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    return { ...candidate, asset: verifyEmployerIconAsset(asset) };
  } catch { return { ...candidate, asset: { accepted: false, reason: 'asset request failed' } }; }
}));
const result = { ...discovery, candidates };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
