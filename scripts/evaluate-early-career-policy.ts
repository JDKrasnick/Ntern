import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { evaluateCatalogAdmission } from '../src/catalog-admission.js';
import { EARLY_CAREER_POLICY_VERSION } from '../src/early-career-eligibility.js';
import { extractPostingMetadataEvidence, type RoleMetadataArtifact } from '../src/role-metadata.js';
import { processPosting } from '../src/ingestion/processor.js';
import type { EvidenceSource, ProcessedListing } from '../src/types.js';

interface SourceCase {
  caseId: string; company: string; url: string; sourceTitle?: string;
  provider: string; origin: string; observedAt: string; sourceUrl?: string;
  acquisition: string; artifact?: RoleMetadataArtifact;
}
interface Label {
  caseId: string; expected: 'eligible' | 'ineligible' | 'uncertain';
  split: 'calibration' | 'holdout'; reason: string; evidenceQuote?: string;
  kind?: string; technicalScopeExpected?: boolean;
}
interface CoverageReview {
  caseId: string; originalUrl: string;
  reviewOutcome: 'eligible' | 'ineligible' | 'plausible-open-level' | 'unresolved-posting';
  rationale: string; evidenceQuotes: string[]; artifact?: RoleMetadataArtifact;
  sourceClass: EvidenceSource; sourceUrl: string; observedAt: string; acquisition: string;
}
const args = process.argv.slice(2);
function option(name: string, fallback?: string): string {
  const at = args.indexOf(name);
  const value = at < 0 ? fallback : args[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}
const corpusPath = option('--corpus'), labelsPath = option('--labels');
const split = option('--split', 'all');
const output = option('--output', '.context/early-career-policy-evaluation.json');
if (!['calibration', 'holdout', 'all'].includes(split)) throw new Error('Invalid split');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const [corpusText, labelsText] = await Promise.all([readFile(corpusPath, 'utf8'), readFile(labelsPath, 'utf8')]);
const manifest = JSON.parse(await readFile(join(dirname(labelsPath), 'label-freeze.json'), 'utf8')) as {
  cases: number; corpusSha256: string; labelsSha256: string;
};
if (sha(corpusText) !== manifest.corpusSha256 || sha(labelsText) !== manifest.labelsSha256) {
  throw new Error('Frozen source evidence or labels changed');
}
const corpus = JSON.parse(corpusText) as SourceCase[];
const labels = JSON.parse(labelsText) as Label[];
if (corpus.length !== 200 || labels.length !== 200 || manifest.cases !== 200
  || new Set(corpus.map(c => c.caseId)).size !== 200 || new Set(labels.map(c => c.caseId)).size !== 200) {
  throw new Error('Evaluation requires exactly 200 unique source cases and labels');
}
const byId = new Map(labels.map(l => [l.caseId, l]));
const reviews = new Map<string, CoverageReview>();
let reviewSha256: string | undefined;
if (args.includes('--review')) {
  const reviewPath = option('--review');
  const content = await readFile(reviewPath, 'utf8');
  const freeze = JSON.parse(await readFile(join(dirname(reviewPath), 'review-freeze.json'), 'utf8')) as {
    cases: number; reviewSha256: string;
  };
  if (sha(content) !== freeze.reviewSha256 || freeze.cases !== 60) throw new Error('Coverage review changed');
  const reviewed = JSON.parse(content) as { policyVersion: number; cases: CoverageReview[] };
  if (reviewed.cases.length !== 60) throw new Error('Wrong review cohort');
  for (const item of reviewed.cases) {
    if (reviews.has(item.caseId) || byId.get(item.caseId)?.expected !== 'uncertain'
      || corpus.find(c => c.caseId === item.caseId)?.url !== item.originalUrl) throw new Error('Invalid coverage overlay identity');
    reviews.set(item.caseId, item);
  }
  reviewSha256 = freeze.reviewSha256;
}
const rows = corpus.flatMap(c => {
  const label = byId.get(c.caseId);
  if (!label) throw new Error('Missing frozen label');
  if (split !== 'all' && label.split !== split) return [];
  const review = reviews.get(c.caseId);
  const artifact = review?.artifact ?? c.artifact;
  const observedAt = review?.observedAt ?? c.observedAt;
  const expected = review?.reviewOutcome === 'plausible-open-level' || label.kind === 'permitted-unspecified' || label.technicalScopeExpected === false
    ? 'ineligible' : review?.reviewOutcome === 'eligible' || review?.reviewOutcome === 'ineligible'
      ? review.reviewOutcome : label.expected;
  const metadataEvidence = artifact ? extractPostingMetadataEvidence({
    artifact, sourceClass: review?.sourceClass ?? 'official-api', sourceId: 'evaluation',
    sourceUrl: review?.sourceUrl ?? c.sourceUrl ?? c.url, observedAt, exactPosting: true,
  }) : [];
  const listing: ProcessedListing = {
    sourceId: 'evaluation', externalId: c.caseId, document: c.caseId, sourceUrl: c.url, row: 1,
    company: c.company, title: c.sourceTitle ?? artifact?.title ?? 'Community-reported internship',
    location: 'Remote', locations: ['Remote'], season: 'summer-2027', applyUrl: c.url,
    state: 'open', technical: true, compensation: { raw: '' }, fetchedAt: observedAt, metadataEvidence,
    employerEvidence: { authority: 'reviewed-registry', canonicalEmployer: { id: c.company, displayName: c.company } },
  };
  // Compose the real source intake and technical check; identity/destination
  // are held valid. These normalized artifacts do not replay provider adapters.
  const intake = processPosting({ sourceId: 'evaluation', externalId: c.caseId, sourceUrl: c.url, fetchedAt: observedAt,
    provenance: c.origin === 'catalog' ? 'reviewed-community' : 'official-ats',
    employer: { id: c.company, name: c.company, authority: 'reviewed-registry' },
    title: c.sourceTitle ?? artifact?.title ?? 'Community-reported internship',
    content: artifact ? [{ kind: 'description', format: 'plain', value: artifact.text ?? '' }] : [],
    locations: ['Remote'], applyUrl: c.url, sourceState: 'open',
    ...(c.origin === 'catalog' ? { lifecycleAuthority: 'source' as const } : {}),
  }, [], true);

  const admission = evaluateCatalogAdmission({
    listing, destination: { classification: 'posting-detail', candidateUrl: c.url, provider: 'unknown', inspectedAt: observedAt },
    postingAttributed: true, evaluatedAt: observedAt, earlyCareerEligibilityEnabled: true,
  });
  const actual = admission.earlyCareer!;
  const admitted = Boolean(intake.listing?.technical && admission.catalogEligible);
  const alertEligible = admitted && admission.alertEligible;
  return [{
    caseId: c.caseId, company: c.company, title: artifact?.title ?? null, url: c.url,
    origin: c.origin, provider: c.provider, acquisition: review?.acquisition ?? c.acquisition,
    originalExpected: label.expected, expected, predicted: actual.status,
    admitted, alertEligible, intakeDecision: intake.decision, programType: actual.programType ?? 'unknown',
    reason: actual.reason, evidence: actual.evidence, split: label.split,
    reviewOutcome: review?.reviewOutcome, reviewReason: review?.rationale ?? label.reason,
    reviewEvidence: review?.evidenceQuotes ?? (label.evidenceQuote ? [label.evidenceQuote] : []),
    falseAdmission: expected === 'ineligible' && admitted,
    falseExclusion: expected === 'eligible' && !admitted,
    uncertainCandidate: expected === 'uncertain' && admitted,
    uncertainAlert: expected === 'uncertain' && alertEligible,
    unresolvedAdmission: expected === 'uncertain' && admitted,
  }];
});
const count = (predicate: (row: typeof rows[number]) => boolean) => rows.filter(predicate).length;
const positives = count(r => r.expected === 'eligible'), negatives = count(r => r.expected === 'ineligible');
const summary = {
  policyVersion: EARLY_CAREER_POLICY_VERSION, split, cases: rows.length, sourceCases: 200,
  corpusSha256: manifest.corpusSha256, labelsSha256: manifest.labelsSha256, reviewSha256,
  eligibleLabels: positives, ineligibleLabels: negatives, uncertainLabels: count(r => r.expected === 'uncertain'),
  acquired: count(r => r.acquisition === 'acquired'), unavailable: count(r => r.acquisition !== 'acquired'),
  truePositives: count(r => r.expected === 'eligible' && r.admitted),
  trueNegatives: count(r => r.expected === 'ineligible' && !r.admitted),
  falseAdmissions: count(r => r.falseAdmission), falseExclusions: count(r => r.falseExclusion),
  uncertainCandidates: count(r => r.uncertainCandidate), uncertainAlerts: count(r => r.uncertainAlert),
  unresolvedAdmissions: count(r => r.unresolvedAdmission),
  admitted: count(r => r.admitted), alertEligible: count(r => r.alertEligible),
  assessedUnknown: count(r => r.predicted === 'unknown'), rejected: count(r => r.predicted === 'ineligible'),
  falseAdmissionRate: negatives ? count(r => r.falseAdmission) / negatives : null,
  falseExclusionRate: positives ? count(r => r.falseExclusion) / positives : null,
  scope: 'Retrospective frozen-cohort replay of explicit-employer programme policy. Original evidence/labels remain unchanged; the reported scope overlay excludes previously permitted general roles. Same reviewer, not an independent human review or a population accuracy estimate. Real source intake, technical check, metadata extraction and admission; identity/destination held valid. Normalized inputs do not replay source adapters or live durable writes.',
};
await writeFile(output, JSON.stringify({ summary, rows }, null, 2) + '\n');
const columns = ['caseId', 'company', 'title', 'url', 'origin', 'provider', 'acquisition', 'originalExpected', 'expected', 'predicted',
  'admitted', 'alertEligible', 'programType', 'reason', 'reviewOutcome', 'reviewReason', 'reviewEvidence', 'evidence',
  'falseAdmission', 'falseExclusion', 'uncertainCandidate'] as const;
const csvValue = (value: unknown) => '"' + String(Array.isArray(value) ? value.join(' | ') : value ?? '').replaceAll('"', '""') + '"';
await writeFile(output.replace(/\.json$/u, '') + '.csv',
  [columns.join(','), ...rows.map(row => columns.map(column => csvValue(row[column])).join(','))].join('\n') + '\n');
console.log(JSON.stringify({ summary, disagreements: rows.filter(r => r.falseAdmission || r.falseExclusion || r.uncertainAlert || r.unresolvedAdmission) }, null, 2));
if (summary.falseAdmissions || summary.falseExclusions || summary.uncertainAlerts || summary.unresolvedAdmissions) process.exitCode = 1;
