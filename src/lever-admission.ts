import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { reviewedLeverSources, type ReviewedLeverSource } from './sources/lever-config.js';
import {
  buildLeverCandidateLedger,
  type LeverCandidate,
  type LeverCandidateSighting,
} from './sources/lever-ledger.js';
import {
  evidenceViolations,
  reviewedSourceFromEvidence,
  type LeverOwnershipEvidence,
} from './sources/lever-evidence.js';
import { registrableDomain } from './core/registrable-domain.js';
import { probeLeverCandidate, type LeverCandidateProbeResult } from './sources/lever-probe.js';
import type { InternshipStore, LeverAdmission } from './store.js';

const MAX_EVIDENCE_BYTES = 1_000_000;
const MAX_REDIRECTS = 4;

export interface LeverAdmissionInput {
  displayName: string;
  careersUrl: string;
  firstPartyEvidenceUrl: string;
  /** Exact anchor markup copied by the reviewer when the employer refuses the operations Lambda. */
  evidenceExcerpt?: string;
}

export interface LeverAdmissionCheck {
  candidate: LeverCandidate;
  evidence: LeverOwnershipEvidence;
  probe: LeverCandidateProbeResult & { state: 'ok' };
  source: ReviewedLeverSource;
}

function isPrivateAddress(address: string): boolean {
  if (address === '::1' || address === '0.0.0.0') return true;
  if (address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  if (!address.includes('.')) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function assertPublicHttps(url: URL): Promise<void> {
  if (url.protocol !== 'https:') throw new Error('Evidence pages must use HTTPS.');
  if (!url.hostname.includes('.') || url.hostname === 'localhost') throw new Error('Evidence must be on a public employer website.');
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Evidence must resolve only to public internet addresses.');
  }
}

async function fetchEvidencePage(input: string, fetchImpl: typeof fetch): Promise<{ finalUrl: URL; markup: string }> {
  let current: URL;
  try {
    current = new URL(input);
  } catch {
    throw new Error('Evidence URL is not valid.');
  }
  const originalDomain = registrableDomain(current.hostname.toLowerCase());
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicHttps(current);
    if (registrableDomain(current.hostname.toLowerCase()) !== originalDomain) {
      throw new Error('Evidence redirected away from the employer domain.');
    }
    const response = await fetchImpl(current, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Evidence page returned a redirect without a destination.');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`Evidence page returned HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_EVIDENCE_BYTES) throw new Error('Evidence page is too large to inspect safely.');
    const markup = await response.text();
    if (Buffer.byteLength(markup) > MAX_EVIDENCE_BYTES) throw new Error('Evidence page is too large to inspect safely.');
    return { finalUrl: current, markup };
  }
  throw new Error('Evidence page redirected too many times.');
}

function evidenceExcerpt(markup: string, site: string): string {
  const marker = `jobs.lever.co/${site}`;
  const index = markup.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) throw new Error(`The employer page does not link to jobs.lever.co/${site}.`);
  return markup.slice(Math.max(0, index - 500), Math.min(markup.length, index + marker.length + 500));
}

export async function listLeverCandidates(store: InternshipStore, now = new Date()): Promise<LeverCandidate[]> {
  if (!store.listOpen || !store.listLeverAdmissions) return [];
  const sightings: LeverCandidateSighting[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listOpen(cursor, 100, 'open');
    cursor = page.cursor;
    for (const job of page.jobs) {
      sightings.push(...job.sourceReferences.map((reference) => ({
        sourceId: reference.sourceId,
        company: reference.company || job.company,
        applyUrl: reference.applyUrl || job.applyUrl,
      })));
      if (!job.sourceReferences.length) {
        sightings.push({ sourceId: 'catalog', company: job.company, applyUrl: job.applyUrl });
      }
    }
  } while (cursor);
  const admissions = await store.listLeverAdmissions();
  return buildLeverCandidateLedger(sightings, {
    registeredSites: [...reviewedLeverSources.map(({ site }) => site), ...admissions.map(({ source }) => source.site)],
    firstSeenAt: now.toISOString(),
  });
}

export async function verifyLeverAdmission(
  store: InternshipStore,
  site: string,
  input: LeverAdmissionInput,
  dependencies: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<LeverAdmissionCheck> {
  const candidate = (await listLeverCandidates(store, (dependencies.now ?? (() => new Date()))()))
    .find((entry) => entry.site === site);
  if (!candidate) throw new Error('This Lever site is not in the observed candidate queue.');
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('Employer display name is required.');
  const careersUrl = new URL(input.careersUrl);
  const evidenceUrl = new URL(input.firstPartyEvidenceUrl);
  if (registrableDomain(careersUrl.hostname.toLowerCase()) !== registrableDomain(evidenceUrl.hostname.toLowerCase())) {
    throw new Error('Careers and evidence URLs must be on the same employer domain.');
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  let page: { finalUrl: URL; markup: string; reviewerSupplied?: boolean };
  try {
    page = await fetchEvidencePage(evidenceUrl.toString(), fetchImpl);
  } catch (error) {
    if (!input.evidenceExcerpt?.trim()) throw error;
    await assertPublicHttps(evidenceUrl);
    page = { finalUrl: evidenceUrl, markup: input.evidenceExcerpt, reviewerSupplied: true };
  }
  const probe = await probeLeverCandidate(site, fetchImpl, (dependencies.now ?? (() => new Date()))().toISOString());
  if (probe.state !== 'ok') throw new Error(`Lever board probe was inconclusive (${probe.state}).`);
  if (!probe.rawPostings) throw new Error('Lever board is empty; admission needs explicit special-case review.');
  if (probe.malformedRows || probe.urlContractViolations || Object.keys(probe.applicationHostSummary).some((host) => host !== 'jobs.lever.co')) {
    throw new Error('Lever board failed the clean URL and posting-shape contract.');
  }
  const verifiedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const evidence: LeverOwnershipEvidence = {
    site,
    displayName,
    careersUrl: careersUrl.toString(),
    firstPartyEvidenceUrl: page.finalUrl.toString(),
    evidenceExcerpt: evidenceExcerpt(page.markup, site),
    observedJobUrl: candidate.sampleJobUrl,
    initialHosts: ['jobs.lever.co'],
    region: 'global',
    state: 'ownership-verified',
    verifiedAt,
    ...(page.reviewerSupplied ? { notes: 'Exact employer-page anchor markup supplied by the approving reviewer because automated retrieval was unavailable.' } : {}),
  };
  const violations = evidenceViolations(evidence);
  if (violations.length) throw new Error(violations.join('; '));
  return { candidate, evidence, probe, source: reviewedSourceFromEvidence(evidence) };
}

export async function acceptLeverAdmission(
  store: InternshipStore,
  site: string,
  input: LeverAdmissionInput,
  acceptedBy: string,
  dependencies: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<LeverAdmission> {
  if (!store.putLeverAdmission) throw new Error('Lever admissions are not configured.');
  const checked = await verifyLeverAdmission(store, site, input, dependencies);
  const admission: LeverAdmission = {
    source: checked.source,
    evidence: checked.evidence,
    probe: checked.probe,
    acceptedAt: checked.evidence.verifiedAt,
    acceptedBy,
  };
  await store.putLeverAdmission(admission);
  return admission;
}
