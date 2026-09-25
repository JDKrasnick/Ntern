#!/usr/bin/env node
/**
 * Read-only company-icon evaluation.
 *
 * Runs the same `diagnoseEmployerIcon` the live sweep and the read-only coverage
 * script use over a labeled set of employers, and scores what it would publish
 * against verified ground truth:
 *
 *   correct           a published domain equal to the label
 *   false-positive    a published domain that differs from the label
 *   miss              a labeled domain with nothing published
 *   correct-monogram  a case that accepts a monogram and published nothing
 *
 * It is the icon counterpart of `scripts/shadow-extraction-eval.ts`: same shape,
 * same `eval/` report location, same credentials from the environment or `.env`.
 * It writes nothing — no D1 row, no R2 object, no queue message.
 *
 * `--no-model` disables the bounded tie-breaker, which is how the deterministic
 * score/declaration path is measured on its own (the provider and page fetches
 * still happen; only the LLM call is skipped).
 *
 * Usage:
 *   tsx scripts/company-icon-eval.ts [--labels <file>] [--report <base>]
 *     [--no-model] [--json] [--limit <n>] [--concurrency <n>] [--strict]
 *
 * `--strict` exits non-zero when any case is a false positive.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { lookup } from 'node:dns/promises';
import { diagnoseEmployerIcon, type EmployerIconDiagnostic } from '../cloudflare/employer-icon-resolver.js';
import type { EmployerIconSeed } from '../src/employer-icon-resolution.js';
import type { HostResolver } from '../src/employer/safe-network.js';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const has = (name: string) => args.includes(name);

const labelsPath = option('--labels') ?? 'test/fixtures/company-icon-eval.json';
const reportBase = option('--report') ?? 'eval/company-icon-results';
const concurrency = Math.max(1, Number(option('--concurrency') ?? 4));
const limit = Number(option('--limit') ?? 0);
const asJson = has('--json');
const strict = has('--strict');
const useModel = !has('--no-model');

function fromEnvironment(name: string): string | undefined {
  const direct = process.env[name];
  if (direct) return direct;
  try { return readFileSync('.env', 'utf8').match(new RegExp(`^${name}=(.+)$`, 'mu'))?.[1]?.trim(); } catch { return undefined; }
}

const logoDevToken = fromEnvironment('LOGO_DEV_TOKEN') ?? fromEnvironment('LOGO_SECRET_KEY');
const logoDevImageToken = fromEnvironment('LOGO_DEV_IMAGE_TOKEN') ?? fromEnvironment('LOGO_PUBLISHABLE_KEY')
  ?? fromEnvironment('LOGO_DEV_PUBLISHABLE_KEY') ?? fromEnvironment('LOGO_DEV_PUBLISHABLE_TOKEN');
const brandfetchClientId = fromEnvironment('BRANDFETCH_CLIENT_ID');
const openAiKey = useModel ? (fromEnvironment('OPENAI_API_KEY') ?? fromEnvironment('OPENAI_KEY')) : undefined;
const credentials = {
  ...(logoDevToken ? { logoDevToken } : {}),
  ...(logoDevImageToken ? { logoDevImageToken } : {}),
  ...(brandfetchClientId ? { brandfetchClientId } : {}),
};

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

interface EvalCase {
  id: string;
  displayName: string;
  applicationUrl?: string;
  roleTitle?: string;
  provider?: string;
  tenant?: string;
  sourceId?: string;
  provenance?: 'official-ats' | 'official-structured' | 'employer-submitted' | 'reviewed-community';
  expectedDomain?: string;
  expectMonogram?: boolean;
  note?: string;
}

const parsed = JSON.parse(await readFile(labelsPath, 'utf8')) as { cases?: EvalCase[] };
const cases = (parsed.cases ?? []).slice(0, limit > 0 ? limit : undefined);
if (!cases.length) { console.error(`No cases in ${labelsPath}`); process.exit(1); }

/** The domain the sweep would publish, taken from the accepting path only. */
function publishedDomain(diagnostic: EmployerIconDiagnostic): string | undefined {
  const domain = diagnostic.confirmedDomain?.domain
    ?? (diagnostic.tieBreak?.accepted === true ? diagnostic.tieBreak.domain : undefined)
    ?? (diagnostic.proposal?.reasonCode === 'verified' ? diagnostic.proposal.domain ?? undefined : undefined)
    ?? (diagnostic.decision.outcome === 'resolved' ? diagnostic.decision.selectedDomain : undefined);
  return domain && diagnostic.imageVerified === true ? domain : undefined;
}

type Verdict = 'correct' | 'correct-monogram' | 'false-positive' | 'miss' | 'inconclusive' | 'error';
interface Row {
  id: string;
  expected: string;
  actual: string;
  verdict: Verdict;
  path: string;
  pageFailure?: string;
  note?: string;
}

const rows: Row[] = [];
let cursor = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < cases.length) {
    const testCase = cases[cursor++]!;
    const seed: EmployerIconSeed = {
      canonicalEmployerId: testCase.id,
      displayName: testCase.displayName,
      roleTitle: testCase.roleTitle ?? '',
      applicationUrl: testCase.applicationUrl ?? '',
      provider: testCase.provider ?? 'unknown',
      sourceId: testCase.sourceId ?? testCase.id,
      ...(testCase.tenant ? { tenant: testCase.tenant } : {}),
      ...(testCase.provenance ? { provenance: testCase.provenance } : {}),
    };
    const expected = testCase.expectMonogram ? '(monogram)' : testCase.expectedDomain ?? '(unlabeled)';
    try {
      const diagnostic = await diagnoseEmployerIcon({
        seed, credentials, deps: { resolver: nodeResolver },
        ...(openAiKey ? { tieBreakApiKey: openAiKey } : {}),
      });
      const actual = publishedDomain(diagnostic);
      const path = diagnostic.confirmedDomain ? 'proof'
        : diagnostic.decision.outcome === 'resolved' ? 'score'
          : diagnostic.tieBreak?.accepted === true ? 'tie-break'
            : diagnostic.proposal?.reasonCode === 'verified' ? 'proposal' : 'none';
      // A page the platform refused to serve is a retrieval failure, not a wrong answer:
      // the same employer usually passes on a re-run, so the case is inconclusive rather
      // than counted against the resolver's accuracy.
      const pageFailure = diagnostic.pageFailure
        ? `${diagnostic.pageFailure}${diagnostic.pageStatus ? `(${diagnostic.pageStatus})` : ''}` : undefined;
      const raw: Verdict = testCase.expectMonogram
        ? (actual ? 'false-positive' : 'correct-monogram')
        : actual === testCase.expectedDomain ? 'correct'
          : actual ? 'false-positive' : 'miss';
      const verdict: Verdict = pageFailure && (raw === 'false-positive' || raw === 'miss') ? 'inconclusive' : raw;
      rows.push({
        id: testCase.id, expected, actual: actual ?? '(none)', verdict, path,
        ...(pageFailure ? { pageFailure } : {}),
        ...(testCase.note ? { note: testCase.note } : {}),
      });
    } catch (error) {
      rows.push({ id: testCase.id, expected, actual: '(error)', verdict: 'error', path: 'none',
        note: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160) });
    }
  }
}));

rows.sort((left, right) => left.id.localeCompare(right.id));
const tally = (values: Verdict[]) => values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<Verdict, number>());
const counts = tally(rows.map((row) => row.verdict));
const summary = {
  labels: labelsPath,
  model: useModel && openAiKey ? 'enabled' : 'disabled',
  total: rows.length,
  correct: counts.get('correct') ?? 0,
  correctMonogram: counts.get('correct-monogram') ?? 0,
  falsePositives: counts.get('false-positive') ?? 0,
  misses: counts.get('miss') ?? 0,
  inconclusive: counts.get('inconclusive') ?? 0,
  errors: counts.get('error') ?? 0,
  rows,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\ncompany-icon eval over ${rows.length} labeled employers (model: ${summary.model})`);
  console.log(`  correct ${summary.correct}  monogram-ok ${summary.correctMonogram}  false-positive ${summary.falsePositives}  miss ${summary.misses}  inconclusive ${summary.inconclusive}  error ${summary.errors}`);
  for (const row of rows.filter((entry) => entry.verdict !== 'correct' && entry.verdict !== 'correct-monogram')) {
    const page = row.pageFailure ? ` page=${row.pageFailure}` : '';
    console.log(`  ${row.verdict.padEnd(15)} ${row.id.padEnd(22)} expected ${row.expected.padEnd(28)} got ${row.actual.padEnd(24)} [${row.path}]${page}`);
  }
  console.log('\nRead-only: nothing was enqueued, published, or written.');
}

const jsonPath = `${reportBase}.json`;
await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
const markdown = [
  '# Company icon evaluation',
  '',
  `Labels: \`${labelsPath}\`  ·  model: **${summary.model}**  ·  ${rows.length} cases`,
  '',
  `Correct **${summary.correct}**, monogram-ok **${summary.correctMonogram}**, false-positive **${summary.falsePositives}**, miss **${summary.misses}**, inconclusive **${summary.inconclusive}**, error **${summary.errors}**`,
  '',
  '| Employer | Expected | Got | Verdict | Path | Page | Note |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((row) => `| ${row.id} | ${row.expected} | ${row.actual} | ${row.verdict} | ${row.path} | ${row.pageFailure ?? ''} | ${row.note ?? ''} |`),
  '',
].join('\n');
await writeFile(`${reportBase}.md`, markdown);
console.log(`\nreport: ${jsonPath} and ${reportBase}.md`);

if (strict && summary.falsePositives > 0) process.exitCode = 1;
