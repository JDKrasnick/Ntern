#!/usr/bin/env node
/**
 * Read-only coverage of the employers' own uploaded board logos.
 *
 * The icon sweep gets its best asset for free: the posting page it already reads
 * publishes the employer's own mark on the platform's board-logo host. This measures
 * how much of the live catalog that path actually covers, per platform, and why each
 * employer it misses is missed — a board that publishes no art, art that is not a
 * servable raster, or a page the platform would not answer.
 *
 * The cohort is the employers the sweep will act on: every canonical employer with a
 * reviewed mapping for a supported ATS (`employer_mappings`), reached through a
 * posting whose application URL is hosted by that platform. An employer whose posting
 * rides a vanity host resolves through the domain path instead and is reported
 * separately, because no board logo is published for it.
 *
 * Everything here is real: the real page fetch, the real candidate extraction, and the
 * real asset rules. Nothing is written — no D1 row, no R2 object, no queue message.
 *
 * A platform can rate-limit a host that reads a few hundred pages: Greenhouse answers
 * 406 to every job page from such a host, whatever the user agent, while its JSON API
 * keeps answering. Production is unaffected, because the Worker fetches from
 * Cloudflare's egress; to re-measure from a blocked host, route the fetches through a
 * throwaway Worker (`wrangler dev --remote`) instead of assuming the platform broke.
 *
 * Usage:
 *   tsx scripts/company-icon-coverage.ts [--json] [--local] [--database <name>]
 *     [--concurrency <n>] [--employer <id[,id]>] [--platform greenhouse|lever|ashby]
 *
 * With `--resolve` it instead runs the real resolver read-only over the same cohort —
 * real page fetches, real Logo.dev search and image endpoints, and the bounded model
 * call when a key is present — and reports how many employers would publish an icon.
 * Credentials come from the environment or `.env`: `LOGO_DEV_TOKEN` (or
 * `LOGO_SECRET_KEY`) for search, and for images `LOGO_DEV_IMAGE_TOKEN` (or
 * `LOGO_DEV_PUBLISHABLE_KEY`, or `LOGO_DEV_PUBLISHABLE_TOKEN`); a `.env` that carries
 * only the account's own names works unchanged. Also `BRANDFETCH_CLIENT_ID` and
 * `OPENAI_KEY`.
 * `--sample <n>` limits the run so a provider quota is not spent on a first look.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import {
  bannerAssetShapeUsable, iconAssetType, iconSvgAsset, isPlatformBannerUrl, platformLogoUrls,
  logoDevCandidateDomains, logoDevSearchUrl,
} from '../src/employer-icon-discovery.js';
import { employerDistinctiveTerms } from '../src/employer-icon-resolution.js';
import {
  ICON_PAGE_REQUEST_HEADERS, diagnoseEmployerIcon, probeLogoDevImage,
  type EmployerIconDiagnostic, type EmployerIconProviderCredentials,
} from '../cloudflare/employer-icon-resolver.js';
import type { EmployerIconSeed } from '../src/employer-icon-resolution.js';
import type { HostResolver } from '../src/employer/safe-network.js';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const has = (name: string) => args.includes(name);

const database = option('--database') ?? 'intern-notifs-db';
const useLocal = has('--local');
const asJson = has('--json');
const only = (option('--employer') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const onlyPlatform = option('--platform');
const concurrency = Math.max(1, Number(option('--concurrency') ?? 6));
/** Run the real resolver read-only over the cohort instead of only reading board art. */
const resolveMode = has('--resolve');
/** Measure Logo.dev alone over a cohort: its search, then its image endpoint, nothing else. */
const providerAudit = has('--provider-audit');
/** `mapped` is the population the sweep acts on; `wide` adds catalog companies with no mapping. */
const cohort = option('--cohort') ?? 'mapped';
const sample = Number(option('--sample') ?? 0);

function fromEnvironment(name: string): string | undefined {
  const direct = process.env[name];
  if (direct) return direct;
  try { return readFileSync('.env', 'utf8').match(new RegExp(`^${name}=(.+)$`, 'mu'))?.[1]?.trim(); } catch { return undefined; }
}

/**
 * The two Logo.dev credentials, from either name an operator may have provisioned.
 * The secret key authorizes the name search; only the publishable token authorizes
 * `img.logo.dev`, and the wrong one there returns 401.
 */
const logoDevToken = fromEnvironment('LOGO_DEV_TOKEN') ?? fromEnvironment('LOGO_SECRET_KEY');
const configuredImageToken = fromEnvironment('LOGO_DEV_IMAGE_TOKEN');
const configuredPublishableKey = fromEnvironment('LOGO_PUBLISHABLE_KEY');
const configuredPublishableToken = fromEnvironment('LOGO_DEV_PUBLISHABLE_TOKEN');
const logoDevImageToken = configuredImageToken ?? configuredPublishableKey ?? configuredPublishableToken;
const brandfetchClientId = fromEnvironment('BRANDFETCH_CLIENT_ID');
const openAiKey = fromEnvironment('OPENAI_KEY') ?? fromEnvironment('OPENAI_API_KEY');

const credentials: EmployerIconProviderCredentials = {
  ...(logoDevToken ? { logoDevToken } : {}),
  ...(logoDevImageToken ? { logoDevImageToken } : {}),
  ...(brandfetchClientId ? { brandfetchClientId } : {}),
};

/** Node returns IPv4-mapped forms from a family-6 lookup; the A query covered them. */
const IPV4_MAPPED = /^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/u;
const nodeResolver: HostResolver = {
  async resolve(hostname: string) {
    const [ipv4, ipv6] = await Promise.all([
      lookup(hostname, { family: 4, all: true }).catch(() => []),
      lookup(hostname, { family: 6, all: true }).catch(() => []),
    ]);
    return [...ipv4, ...ipv6].map((entry) => entry.address).filter((address) => !IPV4_MAPPED.test(address));
  },
};

/** The platform's own board hosts, as `platformLogoUrls` recognizes them. */
const PLATFORM_HOSTS: Record<string, readonly string[]> = {
  greenhouse: ['job-boards.greenhouse.io', 'boards.greenhouse.io'],
  lever: ['jobs.lever.co'],
  ashby: ['jobs.ashbyhq.com'],
};

const PAGE_TIMEOUT_MS = 10_000;
const PAGE_MAX_BYTES = 512 * 1024;
const ASSET_MAX_BYTES = 2 * 1024 * 1024;

function query(sql: string): Array<Record<string, unknown>> {
  const output = execFileSync('npx', [
    'wrangler', 'd1', 'execute', database, useLocal ? '--local' : '--remote', '--json',
    '--config', 'wrangler.api.jsonc', '--command', sql,
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const pages = JSON.parse(output) as Array<{ results?: Array<Record<string, unknown>> }>;
  return pages.flatMap((page) => page.results ?? []);
}

interface CohortEntry {
  platform: string;
  employer: string;
  url: string;
  /** Posting fields the resolver's seed carries, so `--resolve` runs the real path. */
  title?: string;
  provider?: string;
  sourceId?: string;
  provenance?: string;
  displayName?: string;
}

function platformOf(url: string): string | undefined {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return undefined; }
  return Object.entries(PLATFORM_HOSTS)
    .find(([, hosts]) => hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`)))?.[0];
}

function buildCohort(): { entries: CohortEntry[]; vanityHosted: number } {
  // A reviewed mapping for any supported ATS is what makes the sweep act on an
  // employer at all; which platform hosts the live posting is a separate fact.
  const mappings = query(`SELECT canonical_employer_id FROM employer_mappings
    WHERE superseded_at IS NULL AND provider IN ('greenhouse', 'lever', 'ashby')`);
  const mapped = new Set(mappings.map((row) => String(row.canonical_employer_id)));
  const postings = query(`SELECT json_extract(value, '$.internshipIdentity.company.canonicalId') AS employer_id,
      json_extract(value, '$.normalizedUrl') AS url,
      json_extract(value, '$.title') AS title,
      json_extract(value, '$.admission.destination.provider') AS provider,
      json_extract(value, '$.sourceReferences[0].sourceId') AS source_id,
      json_extract(value, '$.sourceReferences[0].provenance') AS provenance
    FROM catalog_items WHERE kind = 'internship'`);
  const entries = new Map<string, CohortEntry>();
  const vanity = new Set<string>();
  for (const row of postings) {
    const employer = row.employer_id ? String(row.employer_id) : '';
    const url = row.url ? String(row.url) : '';
    if (!employer || !url || !mapped.has(employer)) continue;
    const platform = platformOf(url);
    if (!platform) { if (!entries.has(employer)) vanity.add(employer); continue; }
    // One posting per employer is enough: the board logo is a property of the board.
    if (!entries.has(employer)) {
      entries.set(employer, {
        platform, employer, url,
        ...(row.title ? { title: String(row.title) } : {}),
        ...(row.provider ? { provider: String(row.provider) } : {}),
        ...(row.source_id ? { sourceId: String(row.source_id) } : {}),
        ...(row.provenance ? { provenance: String(row.provenance) } : {}),
      });
    }
  }
  const names = query('SELECT id, display_name FROM canonical_employers');
  for (const entry of entries.values()) {
    entry.displayName = String(names.find((row) => String(row.id) === entry.employer)?.display_name ?? entry.employer);
  }
  return { entries: [...entries.values()], vanityHosted: vanity.size };
}

async function boundedFetch(url: string, maxBytes: number): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
  const response = await fetch(url, {
    headers: ICON_PAGE_REQUEST_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  const body = new Uint8Array(await response.arrayBuffer()).slice(0, maxBytes);
  return { status: response.status, headers: response.headers, body };
}

type AssetOutcome = 'stored' | 'svg-not-servable' | 'banner-not-square' | 'not-a-raster' | 'asset-status' | 'asset-error';

async function inspectAsset(url: string, banner: boolean): Promise<AssetOutcome> {
  try {
    const result = await boundedFetch(url, ASSET_MAX_BYTES);
    if (result.status < 200 || result.status >= 300) return 'asset-status';
    const raster = iconAssetType(result.headers.get('content-type'), result.body);
    if (!raster) return iconSvgAsset(result.headers.get('content-type'), result.body) ? 'svg-not-servable' : 'not-a-raster';
    return banner && !bannerAssetShapeUsable(result.body) ? 'banner-not-square' : 'stored';
  } catch { return 'asset-error'; }
}

interface EmployerResult {
  platform: string;
  employer: string;
  url: string;
  pageStatus?: number;
  candidateKind?: 'logo' | 'banner';
  candidates: number;
  outcome: string;
  reasons: Partial<Record<AssetOutcome, number>>;
}

async function inspect(entry: CohortEntry): Promise<EmployerResult> {
  const base = { platform: entry.platform, employer: entry.employer, url: entry.url, candidates: 0, reasons: {} };
  try {
    const page = await boundedFetch(entry.url, PAGE_MAX_BYTES);
    if (page.status < 200 || page.status >= 300) return { ...base, pageStatus: page.status, outcome: 'page-not-ok' };
    const html = new TextDecoder().decode(page.body);
    const urls = platformLogoUrls(html);
    if (!urls.length) return { ...base, outcome: 'no-board-art' };
    const reasons: Partial<Record<AssetOutcome, number>> = {};
    for (const url of urls) {
      const banner = isPlatformBannerUrl(url);
      const outcome = await inspectAsset(url, banner);
      if (outcome === 'stored') {
        return { ...base, candidates: urls.length, outcome: 'stored', candidateKind: banner ? 'banner' : 'logo', reasons };
      }
      reasons[outcome] = (reasons[outcome] ?? 0) + 1;
    }
    return { ...base, candidates: urls.length, outcome: 'unusable', reasons };
  } catch (error) {
    return { ...base, outcome: `page-error:${error instanceof Error ? error.name : 'unknown'}` };
  }
}

/**
 * The seed posting admission would have handed the resolver, rebuilt from the
 * catalog row: the employer, the link, the provider and board slug the posting came
 * from, and the reviewed provenance that decides whether the link counts as the
 * employer's own application host.
 */
function seedFor(entry: CohortEntry): EmployerIconSeed {
  const provider = entry.provider ?? entry.platform;
  const sourceId = entry.sourceId ?? 'unknown';
  const prefix = `${provider}-`;
  const tenant = sourceId.startsWith(prefix) ? sourceId.slice(prefix.length) : undefined;
  return {
    canonicalEmployerId: entry.employer,
    displayName: entry.displayName ?? entry.employer,
    roleTitle: entry.title ?? '',
    applicationUrl: entry.url,
    provider,
    ...(tenant ? { tenant } : {}),
    sourceId,
    provenance: entry.provenance === 'reviewed-community' ? 'reviewed-community' : 'official-ats',
  };
}

/**
 * Runs the real resolver read-only over the cohort and reports what it decided.
 *
 * A decision publishes only when a path actually accepted a domain *and* the
 * provider served a real image for it, which is the same pair of gates the sweep
 * applies: the deterministic score, an accepted tie-break, or a verified proposal.
 */
async function resolveCohort(entries: readonly CohortEntry[], credentials: EmployerIconProviderCredentials): Promise<void> {
  interface Row {
    platform: string; employer: string; outcome: string; domain?: string; published: boolean;
    providers: Record<string, string>; path: string; tieBreak: string; proposal: string;
    /** Whether Logo.dev's image endpoint has a logo for each domain it nominated. */
    providerImages: Record<string, boolean>;
    /** What the model answered, so a refused decision can be judged rather than assumed. */
    modelDomain?: string | null; modelConfidence?: number;
  }
  const results: Row[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++]!;
      const diagnostic = await diagnoseEmployerIcon({
        seed: seedFor(entry), credentials, deps: { resolver: nodeResolver },
        ...(openAiKey ? { tieBreakApiKey: openAiKey } : {}),
      });
      // The provider's own ceiling, independent of any decision: for the domains it
      // nominated, does its image endpoint actually have a logo? This is the number
      // that says whether a provider can carry an employer at all.
      const providerImages: Record<string, boolean> = {};
      if (credentials.logoDevImageToken) {
        for (const domain of diagnostic.logoDevDomains.slice(0, 2)) {
          const probe = await probeLogoDevImage(domain, credentials.logoDevImageToken, { resolver: nodeResolver });
          providerImages[domain] = probe.available;
        }
      }
      const proposal = diagnostic.proposal?.reasonCode ?? 'not-called';
      const tieBreak = diagnostic.tieBreak ? (diagnostic.tieBreak.accepted ? 'accepted' : `declined:${diagnostic.tieBreak.reasonCode}`) : 'not-called';
      const path = diagnostic.confirmedDomain ? 'proof'
        : diagnostic.decision.outcome === 'resolved' ? 'score'
        : diagnostic.tieBreak?.accepted === true ? 'tie-break'
          : proposal === 'verified' ? 'proposal' : 'none';
      results.push({
        platform: entry.platform, employer: entry.employer,
        outcome: diagnostic.decision.outcome,
        ...(diagnostic.decision.selectedDomain ? { domain: diagnostic.decision.selectedDomain } : {}),
        published: path !== 'none' && diagnostic.imageVerified === true,
        providers: providerOutcomesOf(diagnostic), path, tieBreak, proposal, providerImages,
        ...(diagnostic.tieBreak?.decision ? {
          modelDomain: diagnostic.tieBreak.decision.officialDomain,
          modelConfidence: diagnostic.tieBreak.decision.confidence,
        } : {}),
      });
    }
  }));
  const tally = (values: string[]) => [...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>())]
    .sort((left, right) => right[1] - left[1]).map(([value, count]) => `${value} x${count}`).join(', ');
  const published = results.filter((row) => row.published);
  console.log(`\nreal resolver run (read-only): ${published.length}/${results.length} employers would publish an icon`);
  console.log(`  by platform: ${tally(results.map((row) => `${row.platform}:${results.filter((candidate) => candidate.platform === row.platform && candidate.published).length}/${results.filter((candidate) => candidate.platform === row.platform).length}`)).replace(/ x\d+/gu, '')}`);
  console.log(`  acceptance path: ${tally(results.filter((row) => row.published).map((row) => row.path))}`);
  console.log(`  all decisions: ${tally(results.map((row) => row.outcome))}`);
  console.log(`  tie-break outcomes: ${tally(results.map((row) => row.tieBreak))}`);
  console.log(`  proposal outcomes: ${tally(results.map((row) => row.proposal))}`);
  const belowFloor = results.filter((row) => row.tieBreak.startsWith('declined:confidence-below-floor'));
  console.log(`  below-floor model confidences: ${tally(belowFloor.map((row) => String(row.modelConfidence)))}`);
  console.log(`  below-floor answers: ${belowFloor.map((row) => `${row.employer}->${row.modelDomain}@${row.modelConfidence}`).join(', ')}`);
  console.log(`  provider outcomes: ${tally(results.flatMap((row) => Object.entries(row.providers).map(([name, outcome]) => `${name}:${outcome}`)))}`);
  const nominated = results.flatMap((row) => Object.entries(row.providerImages));
  console.log(`  logo.dev image for a nominated domain: ${nominated.filter(([, has]) => has).length}/${nominated.length} domains`
    + ` across ${results.filter((row) => Object.keys(row.providerImages).length).length} employers`);
  console.log(`  unmatched (no image for the accepted domain): ${tally(results.filter((row) => row.path !== 'none' && !row.published).map((row) => `${row.path}:${row.providers['logo-dev'] ?? 'n/a'}`))}`);
  console.log(`  undecided: ${tally(results.filter((row) => row.path === 'none').map((row) => `${row.outcome}:${row.proposal}`))}`);
  writeFileSync('/tmp/icon-resolve-results.json', JSON.stringify(results, null, 1));
}

function providerOutcomesOf(diagnostic: EmployerIconDiagnostic): Record<string, string> {
  const outcomes: Record<string, string> = {};
  for (const provider of ['logo-dev', 'brandfetch']) {
    outcomes[provider] = diagnostic.providerFailures[provider] ?? (provider === 'logo-dev'
      ? (diagnostic.logoDevDomains.length ? 'nominated' : 'miss')
      : (diagnostic.brandfetchDomains.length ? 'nominated' : 'miss'));
  }
  return outcomes;
}

interface ProviderAuditRow {
  name: string;
  query: 'display-name' | 'brand-terms';
  outcome: 'usable' | 'no-image' | 'name-mismatch' | 'no-results' | 'rate-limited' | 'failed';
  returned: number;
  domain?: string;
}

/**
 * Logo.dev on its own: does its search return a domain for this employer under the
 * name our rules accept, and does its image endpoint then hold a real logo for it?
 *
 * Nothing else is involved — no page fetch, no model, no decision — because the point
 * is to separate *the provider's coverage* from everything this resolver layers on top
 * of it: a search that returns nothing, a search whose results carry no matching name,
 * and a nomination with no image are three different problems with three different
 * fixes.
 */
async function auditLogoDev(names: readonly string[]): Promise<void> {
  const token = logoDevToken;
  const imageToken = logoDevImageToken;
  if (!token) { console.error('LOGO_DEV_TOKEN (or LOGO_SECRET_KEY) is required'); process.exitCode = 1; return; }
  const rows: ProviderAuditRow[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 4)) }, async () => {
    while (cursor < names.length) {
      const name = names[cursor++]!;
      const attempt = async (query: 'display-name' | 'brand-terms'): Promise<ProviderAuditRow> => {
        const query2 = query === 'display-name' ? name : employerDistinctiveTerms(name).join(' ');
        try {
          const response = await fetch(logoDevSearchUrl(query2), { headers: { authorization: `Bearer ${token}` } });
          if (response.status === 429) return { name, query, outcome: 'rate-limited', returned: 0 };
          if (!response.ok) return { name, query, outcome: 'failed', returned: 0 };
          const raw = await response.json() as unknown;
          const returned = Array.isArray(raw) ? raw.length : 0;
          const nominated = logoDevCandidateDomains(raw, name);
          if (!nominated.length) {
            return { name, query, outcome: returned ? 'name-mismatch' : 'no-results', returned };
          }
          if (!imageToken) return { name, query, outcome: 'no-image', returned, domain: nominated[0] };
          const probe = await probeLogoDevImage(nominated[0]!, imageToken, { resolver: nodeResolver });
          return {
            name, query, returned, domain: nominated[0]!,
            outcome: probe.available ? 'usable' : 'no-image',
          };
        } catch { return { name, query, outcome: 'failed', returned: 0 }; }
      };
      let row = await attempt('display-name');
      // The resolver retries once with the brand itself when the full name finds nothing.
      if (row.outcome === 'no-results' || row.outcome === 'name-mismatch') {
        const brand = employerDistinctiveTerms(name).join(' ');
        if (brand && brand !== name.trim().toLowerCase()) {
          const second = await attempt('brand-terms');
          if (second.outcome === 'usable' || second.outcome === 'no-image') row = second;
          else if (row.outcome === 'no-results') row = second;
        }
      }
      rows.push(row);
    }
  }));
  const tally = (values: string[]) => [...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>())]
    .sort((left, right) => right[1] - left[1]).map(([value, count]) => `${value} x${count}`).join(', ');
  const usable = rows.filter((row) => row.outcome === 'usable');
  console.log(`\nLogo.dev alone over ${rows.length} employer names (images: ${imageToken ? 'checked' : 'NOT checked'})`);
  console.log(`  search + image usable: ${usable.length}/${rows.length} = ${Math.round(100 * usable.length / rows.length)}%`);
  console.log(`  outcomes: ${tally(rows.map((row) => row.outcome))}`);
  console.log(`  resolved by: ${tally(usable.map((row) => row.query))}`);
  for (const outcome of ['name-mismatch', 'no-results', 'no-image'] as const) {
    const examples = rows.filter((row) => row.outcome === outcome).slice(0, 8);
    if (examples.length) {
      console.log(`  ${outcome} examples:`);
      for (const row of examples) {
        console.log(`    ${row.name.slice(0, 44).padEnd(46)} returned=${String(row.returned).padEnd(3)} ${row.domain ?? ''}`);
      }
    }
  }
  writeFileSync('/tmp/provider-audit.json', JSON.stringify(rows, null, 1));
}

async function main(): Promise<void> {
  if (providerAudit) {
    if (cohort === 'wide') {
      // Every distinct company name on a platform host, including postings with no
      // canonical employer — the population a bigger sweep would have to handle.
      const wide = query(`SELECT DISTINCT json_extract(value, '$.internshipIdentity.company.displayName.value') AS name
        FROM catalog_items WHERE kind = 'internship'
          AND (json_extract(value, '$.normalizedUrl') LIKE '%//job-boards.greenhouse.io/%'
            OR json_extract(value, '$.normalizedUrl') LIKE '%//jobs.lever.co/%'
            OR json_extract(value, '$.normalizedUrl') LIKE '%//jobs.ashbyhq.com/%')`);
      const names = wide.map((row) => String(row.name ?? '')).filter((name) => name.length > 1);
      const selected = sample > 0 ? names.filter((_, index) => index % Math.ceil(names.length / sample) === 0).slice(0, sample) : names;
      await auditLogoDev(selected);
      return;
    }
    const mapped = buildCohort();
    const names = [...new Set(mapped.entries.map((entry) => entry.displayName ?? entry.employer))];
    const selected = sample > 0 && sample < names.length
      ? names.filter((_, index) => index % Math.ceil(names.length / sample) === 0).slice(0, sample) : names;
    await auditLogoDev(selected);
    return;
  }
  const cohortEntries = buildCohort();
  const entries = cohortEntries.entries
    .filter((entry) => (only.length ? only.includes(entry.employer) : true))
    .filter((entry) => (onlyPlatform ? entry.platform === onlyPlatform : true));
  if (!entries.length) {
    console.error(`No employers matched${onlyPlatform ? ` for platform ${onlyPlatform}` : ''}.`);
    process.exitCode = 1;
    return;
  }
  entries.sort((left, right) => left.platform.localeCompare(right.platform) || left.employer.localeCompare(right.employer));
  if (resolveMode) {
    const selected = sample > 0 && sample < entries.length
      // Every nth employer, so a sample is reproducible and spread across platforms.
      ? entries.filter((_, index) => index % Math.ceil(entries.length / sample) === 0).slice(0, sample)
      : entries;
    console.log(`Resolving ${selected.length} employers read-only`
      + ` (search key: ${logoDevToken ? 'set' : 'MISSING'}, image token: ${logoDevImageToken ? 'set' : 'MISSING'},`
      + ` brandfetch: ${brandfetchClientId ? 'set' : 'unconfigured'}, model: ${openAiKey ? 'set' : 'unconfigured'})`);
    await resolveCohort(selected, credentials);
    console.log('Read-only: nothing was enqueued, published, or written.');
    return;
  }
  const results: EmployerResult[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < entries.length) results.push(await inspect(entries[cursor++]!));
  }));

  if (asJson) {
    console.log(JSON.stringify({ vanityHosted: cohortEntries.vanityHosted, results }, null, 2));
    return;
  }
  for (const platform of Object.keys(PLATFORM_HOSTS)) {
    const rows = results.filter((row) => row.platform === platform);
    if (!rows.length) continue;
    const stored = rows.filter((row) => row.outcome === 'stored');
    console.log(`\n${platform}: ${stored.length}/${rows.length} employers with an uploaded board logo (${pct(stored.length, rows.length)})`);
    const tallies = new Map<string, string[]>();
    for (const row of rows.filter((entry) => entry.outcome !== 'stored')) {
      const key = row.outcome === 'unusable'
        ? `unusable: ${Object.entries(row.reasons).map(([reason, count]) => `${reason}×${count}`).join(', ')}`
        : row.outcome === 'page-not-ok' ? `page answered ${row.pageStatus}` : row.outcome;
      tallies.set(key, [...(tallies.get(key) ?? []), row.employer]);
    }
    for (const [key, employers] of [...tallies.entries()].sort((left, right) => right[1].length - left[1].length)) {
      console.log(`  ${String(employers.length).padStart(3)}  ${key}`);
      if (employers.length <= 12) console.log(`       ${employers.join(', ')}`);
    }
  }
  const stored = results.filter((row) => row.outcome === 'stored');
  console.log(`\nall platforms: ${stored.length}/${results.length} (${pct(stored.length, results.length)})`);
  console.log(`banner used instead of a square logo: ${stored.filter((row) => row.candidateKind === 'banner').length}`);
  console.log(`mapped employers whose live posting rides a vanity host (domain path, no board logo): ${cohortEntries.vanityHosted}`);
  console.log('\nRead-only: nothing was enqueued, published, or written.');
}

function pct(part: number, total: number): string {
  return total === 0 ? 'n/a' : `${Math.round((part / total) * 100)}%`;
}

await main();
