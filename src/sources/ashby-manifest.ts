import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { ashbyAdmissionViolations } from './ashby-admission.js';
import { reviewedAshbySources } from './ashby-config.js';
import type { AshbyOwnershipEvidence } from './ashby-evidence.js';
import type { AshbyProbeResult } from './ashby-probe.js';
import { emptyBoardAcknowledgementViolations, type ReviewedSourceRecord } from './reviewed-source.js';

export const ASHBY_EVIDENCE_ROOT = 'test/fixtures/ashby';
const ASHBY_PROMOTION_MIN_SNAPSHOTS = 3;
const ASHBY_PROMOTION_MIN_SPAN_MS = 24 * 60 * 60 * 1000;
const ASHBY_PROMOTION_MAX_LINK_FAILURE_RATE = 0.2;
const CLOCK_SKEW_MS = 5 * 60_000;
const ASHBY_PROMOTION_SUCCESS_OUTCOMES = new Set([
  'success_changed',
  'success_unchanged_304',
  'success_unchanged_hash',
]);

function promotionEvidenceViolations(source: ReviewedSourceRecord, now: Date): string[] {
  if (source.status !== 'published') return [];
  const evidence = source.promotionEvidence;
  if (!evidence) return ['published source lacks promotionEvidence'];
  const violations: string[] = [];
  if (!evidence.approvedBy.trim()) violations.push('promotion evidence lacks approver');
  const approvedAt = Date.parse(evidence.approvedAt);
  if (!Number.isFinite(approvedAt)) violations.push('promotion evidence approvedAt is invalid');
  else if (approvedAt > now.getTime() + CLOCK_SKEW_MS) violations.push('promotion evidence approvedAt is in the future');
  if (!evidence.quietBaselineApproved) violations.push('quiet baseline is not approved');
  if (!evidence.stableIdentity) violations.push('identity is not approved as stable');
  if (!evidence.stableApplicationHosts) violations.push('application hosts are not approved as stable');
  const observationOverride = evidence.observationWindowOverride;
  let observationOverrideActive = false;
  if (observationOverride) {
    if (!observationOverride.reason.trim()) violations.push('observation-window override lacks a reason');
    const followUpAfter = Date.parse(observationOverride.followUpAfter);
    if (!Number.isFinite(followUpAfter)) violations.push('observation-window override followUpAfter is invalid');
    else if (Number.isFinite(approvedAt) && followUpAfter <= approvedAt) {
      violations.push('observation-window override follow-up must be after approval');
    } else if (now.getTime() >= followUpAfter) {
      violations.push('observation-window override follow-up is overdue');
    } else {
      observationOverrideActive = true;
    }
  }
  const minimumSnapshots = observationOverrideActive ? 1 : ASHBY_PROMOTION_MIN_SNAPSHOTS;
  if (evidence.snapshots.length < minimumSnapshots) {
    violations.push(observationOverrideActive
      ? 'observation-window override requires at least one clean snapshot'
      : `promotion requires at least ${ASHBY_PROMOTION_MIN_SNAPSHOTS} clean snapshots`);
    return violations;
  }
  const timestamps = evidence.snapshots.map(({ completedAt }) => Date.parse(completedAt));
  if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) violations.push('promotion snapshot timestamp is invalid');
  else {
    const latestSnapshot = Math.max(...timestamps);
    if (!observationOverrideActive && latestSnapshot - Math.min(...timestamps) < ASHBY_PROMOTION_MIN_SPAN_MS) {
      violations.push('promotion snapshots must span at least 24 hours');
    }
    if (latestSnapshot > now.getTime() + CLOCK_SKEW_MS) violations.push('promotion snapshot timestamp is in the future');
    if (Number.isFinite(approvedAt) && approvedAt < latestSnapshot) {
      violations.push('promotion approval must follow the latest snapshot');
    }
  }
  if (new Set(evidence.snapshots.map(({ runId }) => runId)).size !== evidence.snapshots.length) {
    violations.push('promotion snapshot run IDs must be unique');
  }
  for (const snapshot of evidence.snapshots) {
    if (!ASHBY_PROMOTION_SUCCESS_OUTCOMES.has(snapshot.outcome)) violations.push(`${snapshot.runId}: snapshot did not succeed`);
    if (!snapshot.complete) violations.push(`${snapshot.runId}: snapshot is not complete`);
    if (!snapshot.identityVerified) violations.push(`${snapshot.runId}: identity was not verified`);
    if (!snapshot.schemaValid) violations.push(`${snapshot.runId}: schema was not valid`);
    if (snapshot.eligibleRows + snapshot.withheldRows > snapshot.rawRows) violations.push(`${snapshot.runId}: eligible and withheld rows exceed raw rows`);
    if (snapshot.applicationLinksChecked !== snapshot.eligibleRows) violations.push(`${snapshot.runId}: every eligible application link must be checked exactly once`);
    if (snapshot.applicationLinkFailures > snapshot.applicationLinksChecked) violations.push(`${snapshot.runId}: application-link failures exceed checked links`);
    if (snapshot.applicationLinksChecked > 0
      && snapshot.applicationLinkFailures / snapshot.applicationLinksChecked > ASHBY_PROMOTION_MAX_LINK_FAILURE_RATE) {
      violations.push(`${snapshot.runId}: application-link failure rate exceeds 20%`);
    }
    if ([snapshot.rawRows, snapshot.eligibleRows, snapshot.withheldRows, snapshot.applicationLinksChecked, snapshot.applicationLinkFailures]
      .some((count) => !Number.isInteger(count) || count < 0)) violations.push(`${snapshot.runId}: snapshot counts must be non-negative integers`);
  }
  return violations;
}
export const ASHBY_REVERIFICATION_DAYS = 180;
export const ASHBY_ADMISSION_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

export interface AshbyManifestFs {
  listBoardDirs(root: string): string[];
  fileExists(path: string): boolean;
  readJson(path: string): unknown;
}

export function nodeAshbyManifestFs(): AshbyManifestFs {
  return {
    listBoardDirs: (root) => existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [],
    fileExists: existsSync,
    readJson: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
  };
}

interface ProbeArtifact { probedAt: string; retention: 'metadata-only'; results: AshbyProbeResult[] }

function parse<T>(fs: AshbyManifestFs, path: string): T | string {
  try {
    const value = fs.readJson(path);
    return value && typeof value === 'object' ? value as T : 'is not an object';
  } catch { return 'is not valid JSON'; }
}

export function collectAshbyManifestViolations(
  registry: ReviewedSourceRecord[] = reviewedAshbySources,
  options: { fs: AshbyManifestFs; root?: string; now?: Date } = { fs: nodeAshbyManifestFs() },
): string[] {
  const root = options.root ?? ASHBY_EVIDENCE_ROOT;
  const now = options.now ?? new Date();
  const violations: string[] = [];
  const ids = new Set<string>();
  const boards = new Set<string>();
  const claimedDirs = new Set<string>();

  for (const source of registry) {
    const board = source.identity.boardKey;
    if (ids.has(source.id)) violations.push(`${source.id}: duplicate source id`);
    if (boards.has(board)) violations.push(`${source.id}: duplicate board identity ${board}`);
    ids.add(source.id); boards.add(board); claimedDirs.add(board);
    if (source.identity.provider !== 'ashby') violations.push(`${source.id}: provider is not ashby`);
    if (source.status !== 'shadow' && source.status !== 'published') violations.push(`${source.id}: invalid status`);
    if (source.emptyBoardAcknowledged) {
      for (const issue of emptyBoardAcknowledgementViolations(source.emptyBoardAcknowledged, now)) violations.push(`${source.id}: ${issue}`);
    }
    for (const issue of promotionEvidenceViolations(source, now)) violations.push(`${source.id}: ${issue}`);
    const admitted = Date.parse(source.admittedAt);
    if (Number.isNaN(admitted)) violations.push(`${source.id}: admittedAt is invalid`);
    else if (admitted > now.getTime() + CLOCK_SKEW_MS) violations.push(`${source.id}: admittedAt is in the future`);
    else if (Math.floor((now.getTime() - admitted) / DAY_MS) > ASHBY_REVERIFICATION_DAYS) violations.push(`${source.id}: evidence is overdue for re-verification`);
    const evidencePath = `${root}/${board}/evidence.json`;
    const probePath = `${root}/${board}/probe.json`;
    if (!options.fs.fileExists(evidencePath)) { violations.push(`${source.id}: missing ${evidencePath}`); continue; }
    if (!options.fs.fileExists(probePath)) { violations.push(`${source.id}: missing ${probePath}`); continue; }
    const evidence = parse<AshbyOwnershipEvidence>(options.fs, evidencePath);
    const artifact = parse<ProbeArtifact>(options.fs, probePath);
    if (typeof evidence === 'string') { violations.push(`${source.id}: evidence.json ${evidence}`); continue; }
    if (typeof artifact === 'string') { violations.push(`${source.id}: probe.json ${artifact}`); continue; }
    if (artifact.retention !== 'metadata-only') violations.push(`${source.id}: probe artifact must declare metadata-only retention`);
    const probed = Date.parse(artifact.probedAt);
    if (Number.isNaN(probed)) violations.push(`${source.id}: probe artifact has invalid probedAt`);
    else {
      if (probed > now.getTime() + CLOCK_SKEW_MS) violations.push(`${source.id}: probe artifact probedAt is in the future`);
      if (!Number.isNaN(admitted) && Math.abs(probed - admitted) > ASHBY_ADMISSION_WINDOW_DAYS * DAY_MS) {
        violations.push(`${source.id}: probe and admission timestamps differ by more than ${ASHBY_ADMISSION_WINDOW_DAYS} days`);
      }
    }
    if (!Array.isArray(artifact.results) || artifact.results.length !== 1) { violations.push(`${source.id}: probe artifact must contain exactly one result`); continue; }
    for (const issue of ashbyAdmissionViolations({
      reviewerApprovedOwnership: true, reviewerApprovedAdmission: true, company: source.company,
      evidence, probe: artifact.results[0]!, proposedSource: { ...source, status: 'shadow' },
    })) violations.push(`${source.id}: ${issue}`);
    if (evidence.careersUrl !== source.careersUrl) violations.push(`${source.id}: careers URL differs from evidence`);
    if (Date.parse(evidence.verifiedAt) !== Date.parse(source.admittedAt)) violations.push(`${source.id}: admission timestamp differs from evidence`);
    if (JSON.stringify(evidence.allowedApplicationHosts) !== JSON.stringify(source.allowedApplicationHosts)) violations.push(`${source.id}: allowed hosts differ from evidence`);
  }

  for (const board of options.fs.listBoardDirs(root).sort()) {
    if (claimedDirs.has(board)) continue;
    const evidencePath = `${root}/${board}/evidence.json`;
    if (!options.fs.fileExists(evidencePath)) violations.push(`${board}: unclaimed evidence directory has no evidence.json`);
    else violations.push(`${board}: reviewed evidence is pending explicit registry admission`);
  }
  return violations;
}

export function summariseAshbyManifest(registry: ReviewedSourceRecord[] = reviewedAshbySources) {
  return {
    reviewed: registry.length,
    shadow: registry.filter(({ status }) => status === 'shadow').length,
    published: registry.filter(({ status }) => status === 'published').length,
    boards: registry.map(({ identity }) => identity.boardKey).sort(),
  };
}
