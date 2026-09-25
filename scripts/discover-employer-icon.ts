#!/usr/bin/env node
/**
 * Read-only company-icon diagnostic.
 *
 * It shows exactly what the live resolver would decide for one or more employers
 * — the same evidence, the same candidate order, the same scores, and the same
 * bounded tie-breaker — and then stops. It never writes a task row, an employer
 * column, an R2 object, or a queue message, so it is safe to run against
 * production while the resolver is still in observe mode.
 *
 * Usage:
 *   tsx scripts/discover-employer-icon.ts --employer acme
 *   tsx scripts/discover-employer-icon.ts --employer acme,globex --url https://job-boards.greenhouse.io/acme/jobs/1
 *   tsx scripts/discover-employer-icon.ts --name "Acme" --url https://acme.com/careers --json
 *
 * Reading the employer row requires Wrangler access; pass `--name` instead when
 * you only want a provider and link probe.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { validCompanyIconEmployerId } from '../cloudflare/company-icon.js';
import { diagnoseEmployerIcon, type EmployerIconDiagnostic } from '../cloudflare/employer-icon-resolver.js';
import type { EmployerIconSeed } from '../src/employer-icon-resolution.js';
import type { HostResolver } from '../src/employer/safe-network.js';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const has = (name: string) => args.includes(name);

const employerIds = (option('--employer') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const explicitName = option('--name');
if (!employerIds.length && !explicitName) {
  console.error('Usage: tsx scripts/discover-employer-icon.ts --employer <id[,id]> | --name "<employer>" [--url <applicationUrl>] [--provider <p>] [--tenant <t>] [--title <role>] [--json] [--no-llm] [--local]');
  process.exit(1);
}
for (const id of employerIds) {
  if (!validCompanyIconEmployerId(id)) {
    console.error(`--employer ${id} must be a lowercase canonical employer ID (letters, digits, hyphens)`);
    process.exit(1);
  }
}

const database = option('--database') ?? 'intern-notifs-db';
const useLocal = has('--local');
const asJson = has('--json');
const applicationUrl = option('--url') ?? '';
const provider = option('--provider') ?? 'unknown';
const tenant = option('--tenant');
const roleTitle = option('--title') ?? '';

function fromEnvironment(name: string, dotenvKey = name): string | undefined {
  const direct = process.env[name];
  if (direct) return direct;
  try {
    return readFileSync('.env', 'utf8').match(new RegExp(`^${dotenvKey}=(.+)$`, 'mu'))?.[1]?.trim();
  } catch { return undefined; }
}

// Two different Logo.dev credentials: the secret key authorizes the name search and
// only the publishable token authorizes `img.logo.dev`. Either may be provisioned
// under a second name, so both spellings are read.
const logoDevToken = fromEnvironment('LOGO_DEV_TOKEN') ?? fromEnvironment('LOGO_SECRET_KEY');
const logoDevImageToken = fromEnvironment('LOGO_DEV_IMAGE_TOKEN') ?? fromEnvironment('LOGO_DEV_PUBLISHABLE_TOKEN');
const credentials = {
  ...(logoDevToken ? { logoDevToken } : {}),
  ...(logoDevImageToken ? { logoDevImageToken } : {}),
  ...(fromEnvironment('BRANDFETCH_CLIENT_ID') ? { brandfetchClientId: fromEnvironment('BRANDFETCH_CLIENT_ID')! } : {}),
};
const openAiKey = has('--no-llm') ? undefined : fromEnvironment('OPENAI_API_KEY', 'OPENAI_KEY');

/** Node returns IPv4-mapped forms (`::ffff:198.51.100.7`) from a family-6 lookup; the A query already covered them, and they are not IPv6 evidence. */
const IPV4_MAPPED = /^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/u;

/** The same SSRF boundary the Worker uses, resolved through the local stub resolver. */
const nodeResolver: HostResolver = {
  async resolve(hostname: string) {
    const [ipv4, ipv6] = await Promise.all([
      lookup(hostname, { family: 4, all: true }).catch(() => []),
      lookup(hostname, { family: 6, all: true }).catch(() => []),
    ]);
    return [...ipv4, ...ipv6]
      .map((entry) => entry.address)
      .filter((address) => !IPV4_MAPPED.test(address));
  },
};

interface EmployerRow {
  displayName: string;
  resolutionStatus?: string;
  websiteDomain?: string;
  iconSource?: string;
}

function loadEmployerRow(id: string): EmployerRow | undefined {
  const output = execFileSync('npx', [
    'wrangler', 'd1', 'execute', database, useLocal ? '--local' : '--remote', '--json',
    '--config', 'wrangler.api.jsonc', '--command',
    `SELECT display_name, icon_source, icon_resolution_status, website_domain FROM canonical_employers WHERE id = '${id}'`,
  ], { encoding: 'utf8' });
  const pages = JSON.parse(output) as Array<{ results?: Array<Record<string, unknown>> }>;
  const row = pages.flatMap((page) => page.results ?? [])[0];
  if (!row) return undefined;
  return {
    displayName: String(row.display_name),
    ...(row.icon_source ? { iconSource: String(row.icon_source) } : {}),
    ...(row.icon_resolution_status ? { resolutionStatus: String(row.icon_resolution_status) } : {}),
    ...(row.website_domain ? { websiteDomain: String(row.website_domain) } : {}),
  };
}

function report(diagnostic: EmployerIconDiagnostic, current?: EmployerRow): void {
  const { seed, decision } = diagnostic;
  console.log(`\n=== ${seed.canonicalEmployerId} — ${seed.displayName} ===`);
  console.log(`application link : ${seed.applicationUrl || '(none)'}`);
  console.log(`final url        : ${diagnostic.finalUrl ?? '(not fetched)'}${diagnostic.pageFailure ? ` (${diagnostic.pageFailure})` : ''}`);
  console.log(`redirect hosts   : ${diagnostic.redirectHosts.join(' → ') || '(none)'}`);
  console.log(`page org domains : ${diagnostic.pageOrganizations.join(', ') || '(none)'}`);
  console.log(`logo.dev domains : ${diagnostic.logoDevDomains.join(', ') || '(none)'}`);
  // Display only. Brandfetch's standard terms forbid persisting its results.
  console.log(`brandfetch domains (display only, never persisted): ${diagnostic.brandfetchDomains.join(', ') || '(none)'}`);
  if (Object.keys(diagnostic.providerFailures).length) {
    console.log(`provider failures: ${JSON.stringify(diagnostic.providerFailures)}`);
  }
  console.log('candidates (best first):');
  for (const candidate of decision.scores) {
    const state = candidate.rejected ? `REJECTED (${candidate.rejectionReason})` : candidate.score.toFixed(2);
    console.log(`  ${state.padEnd(10)} ${candidate.domain} [${candidate.signals.join(', ')}]`);
  }
  console.log(`decision         : ${decision.outcome} — ${decision.reason}`);
  if (decision.selectedDomain) console.log(`selected domain  : ${decision.selectedDomain}`);
  if (diagnostic.imageVerified !== undefined) {
    console.log(`image verified   : ${diagnostic.imageVerified ? 'yes' : 'no (monogram would render)'}`);
  }
  if (diagnostic.tieBreak) {
    console.log(`tie-break        : ${diagnostic.tieBreak.accepted ? `accepted ${diagnostic.tieBreak.domain}` : `declined (${diagnostic.tieBreak.reasonCode})`}`);
    console.log(`  model said     : ${JSON.stringify(diagnostic.tieBreak.decision ?? null)}`);
    console.log(`  tokens         : ${diagnostic.tieBreak.inputTokens} in / ${diagnostic.tieBreak.outputTokens} out`);
  } else if (decision.outcome === 'llm-review') {
    console.log('tie-break        : not run (pass an OpenAI key, or the model was skipped)');
  }
  if (current?.resolutionStatus) {
    console.log(`recorded status  : ${current.resolutionStatus}${current.websiteDomain ? ` (${current.websiteDomain})` : ''}${current.iconSource ? ` [${current.iconSource}]` : ''}`);
  }
}

const results: EmployerIconDiagnostic[] = [];
for (const id of employerIds) {
  const row = loadEmployerRow(id);
  if (!row) {
    console.error(`\n${id}: no canonical employer row found (is the migration applied and the ID correct?)`);
    continue;
  }
  const seed: EmployerIconSeed = {
    canonicalEmployerId: id,
    displayName: row.displayName,
    roleTitle,
    applicationUrl,
    provider,
    ...(tenant ? { tenant } : {}),
    sourceId: 'diagnostic',
  };
  const diagnostic = await diagnoseEmployerIcon({
    seed, credentials, deps: { resolver: nodeResolver },
    context: {
      id, displayName: row.displayName,
      ...(row.iconSource ? { iconSource: row.iconSource } : {}),
      ...(row.resolutionStatus ? { resolutionStatus: row.resolutionStatus } : {}),
      ...(row.websiteDomain ? { websiteDomain: row.websiteDomain } : {}),
    },
    ...(openAiKey ? { tieBreakApiKey: openAiKey } : {}),
  });
  results.push(diagnostic);
  if (!asJson) report(diagnostic, row);
}

if (!employerIds.length && explicitName) {
  const seed: EmployerIconSeed = {
    canonicalEmployerId: 'diagnostic', displayName: explicitName, roleTitle, applicationUrl, provider,
    ...(tenant ? { tenant } : {}), sourceId: 'diagnostic',
  };
  const diagnostic = await diagnoseEmployerIcon({
    seed, credentials, deps: { resolver: nodeResolver },
    ...(openAiKey ? { tieBreakApiKey: openAiKey } : {}),
  });
  results.push(diagnostic);
  if (!asJson) report(diagnostic);
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else if (results.length > 1) {
  const resolved = results.filter((entry) => entry.decision.outcome === 'resolved').length;
  const tieBreaks = results.filter((entry) => entry.tieBreak).length;
  const corroborated = results.filter((entry) => entry.decision.scores.some((candidate) => !candidate.rejected
    && candidate.signals.includes('logo-dev') && candidate.signals.includes('brandfetch'))).length;
  console.log(`\n=== summary over ${results.length} employer(s) ===`);
  console.log(`domain accepted : ${resolved} (${((resolved / results.length) * 100).toFixed(0)}%)`);
  console.log(`monogram        : ${results.length - resolved}`);
  console.log(`logo.dev hits   : ${results.filter((entry) => entry.logoDevDomains.length).length}`);
  console.log(`corroborated    : ${corroborated}`);
  console.log(`tie-break calls : ${tieBreaks}`);
}
console.log('\nRead-only: nothing was enqueued, published, or written.');
