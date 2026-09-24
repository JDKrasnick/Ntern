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
 * Usage:
 *   tsx scripts/company-icon-coverage.ts [--json] [--local] [--database <name>]
 *     [--concurrency <n>] [--employer <id[,id]>] [--platform greenhouse|lever|ashby]
 */

import { execFileSync } from 'node:child_process';
import {
  bannerAssetShapeUsable, iconAssetType, iconSvgAsset, isPlatformBannerUrl, platformLogoUrls,
} from '../src/employer-icon-discovery.js';
import { ICON_PAGE_REQUEST_HEADERS } from '../cloudflare/employer-icon-resolver.js';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const has = (name: string) => args.includes(name);

const database = option('--database') ?? 'intern-notifs-db';
const useLocal = has('--local');
const asJson = has('--json');
const only = (option('--employer') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const onlyPlatform = option('--platform');
const concurrency = Math.max(1, Number(option('--concurrency') ?? 6));

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

interface CohortEntry { platform: string; employer: string; url: string }

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
      json_extract(value, '$.normalizedUrl') AS url
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
    if (!entries.has(employer)) entries.set(employer, { platform, employer, url });
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

async function main(): Promise<void> {
  const cohort = buildCohort();
  const entries = cohort.entries
    .filter((entry) => (only.length ? only.includes(entry.employer) : true))
    .filter((entry) => (onlyPlatform ? entry.platform === onlyPlatform : true));
  if (!entries.length) {
    console.error(`No employers matched${onlyPlatform ? ` for platform ${onlyPlatform}` : ''}.`);
    process.exitCode = 1;
    return;
  }
  entries.sort((left, right) => left.platform.localeCompare(right.platform) || left.employer.localeCompare(right.employer));
  const results: EmployerResult[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < entries.length) results.push(await inspect(entries[cursor++]!));
  }));

  if (asJson) {
    console.log(JSON.stringify({ vanityHosted: cohort.vanityHosted, results }, null, 2));
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
  console.log(`mapped employers whose live posting rides a vanity host (domain path, no board logo): ${cohort.vanityHosted}`);
  console.log('\nRead-only: nothing was enqueued, published, or written.');
}

function pct(part: number, total: number): string {
  return total === 0 ? 'n/a' : `${Math.round((part / total) * 100)}%`;
}

await main();
