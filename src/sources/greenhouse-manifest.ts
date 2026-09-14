import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { hostMatchesAllowlist, matchesExpectedBoardName, type ReviewedGreenhouseSource } from './greenhouse-config.js';
import { emptyBoardAcknowledgementViolations } from './reviewed-source.js';
import { isGreenhouseJobShape, mapGreenhouseJob, type GreenhouseJob, type GreenhouseJobsResponse } from './greenhouse.js';

/** Per-company evidence lives under `test/fixtures/greenhouse/{boardToken}/`. */
export const GREENHOUSE_FIXTURE_ROOT = 'test/fixtures/greenhouse';

/** Filesystem port so the checker can be unit-tested without touching disk. */
export interface ManifestFs {
  listBoardDirs(root: string): string[];
  fileExists(path: string): boolean;
  readJson(path: string): unknown;
}

/** Board identity fixture: the sanitized `{ "name": ... }` body the admission check compares. */
function identityFixtureError(raw: unknown, source: ReviewedGreenhouseSource): string | undefined {
  if (!raw || typeof raw !== 'object') return 'identity.json is not an object';
  const name = (raw as { name?: unknown }).name;
  if (typeof name !== 'string' || name.trim() === '') return 'identity.json must contain the returned board name';
  if (!matchesExpectedBoardName(name, source.expectedBoardNames)) return 'identity.json name does not match expectedBoardNames';
  return undefined;
}

/**
 * Jobs fixture coverage. A company's material is incomplete until it exercises
 * that board's real host pattern plus an eligible role, a non-eligible role, and
 * a prospect post, so every reviewed board proves its own filtering behaviour.
 */
function jobsFixtureError(raw: unknown, source: ReviewedGreenhouseSource): string | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as GreenhouseJobsResponse).jobs)) {
    return 'jobs.json must contain a jobs array';
  }
  const jobs = (raw as GreenhouseJobsResponse).jobs ?? [];
  let eligible = 0;
  let nonEligible = 0;
  let prospects = 0;
  for (const job of jobs) {
    if (!isGreenhouseJobShape(job)) return 'jobs.json contains a row that is not a documented Greenhouse job shape';
    const hostError = applicationHostError(job, source);
    if (hostError) return hostError;
    if (job.internal_job_id === null || job.internal_job_id === undefined) prospects += 1;
    else if (mapGreenhouseJob(job, source, FIXTURE_FETCHED_AT)) eligible += 1;
    else nonEligible += 1;
  }
  if (eligible === 0) return 'jobs.json needs at least one eligible technical early-career role';
  if (nonEligible === 0) return 'jobs.json needs at least one non-eligible role';
  if (prospects === 0) return 'jobs.json needs at least one prospect post';
  return undefined;
}

const FIXTURE_FETCHED_AT = '2026-01-01T00:00:00.000Z';

function applicationHostError(job: GreenhouseJob, source: ReviewedGreenhouseSource): string | undefined {
  if (!job.absolute_url) return `jobs.json row ${String(job.id ?? 'unknown')} has no absolute_url`;
  let parsed: URL;
  try {
    parsed = new URL(job.absolute_url);
  } catch {
    return `jobs.json row ${String(job.id ?? 'unknown')} has an unparseable absolute_url`;
  }
  if (parsed.protocol !== 'https:') return `jobs.json row ${String(job.id ?? 'unknown')} is not https`;
  if (parsed.search) return `jobs.json row ${String(job.id ?? 'unknown')} keeps a query string; sanitize it`;
  if (!hostMatchesAllowlist(parsed.hostname, source.allowedInitialHosts)) {
    return `jobs.json application host ${parsed.hostname} is not a reviewed initial host`;
  }
  return undefined;
}

/** Approval artifact: source ID, UTC run time, result counts, host summary, commit SHA. */
function approvalArtifactError(raw: unknown, source: ReviewedGreenhouseSource): string | undefined {
  if (!raw || typeof raw !== 'object') return 'approval.json is not an object';
  const artifact = raw as Record<string, unknown>;
  if (artifact.sourceId !== source.id) return 'approval.json sourceId does not match the reviewed source';
  if (typeof artifact.runAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(artifact.runAt)
    || Number.isNaN(Date.parse(artifact.runAt))) {
    return 'approval.json runAt must be a UTC timestamp';
  }
  if (typeof artifact.commitSha !== 'string' || artifact.commitSha.trim() === '') {
    return 'approval.json commitSha is required';
  }
  const counts = artifact.counts as Record<string, unknown> | undefined;
  if (!counts || ['raw', 'eligible', 'withheld'].some((key) => typeof counts[key] !== 'number')) {
    return 'approval.json counts must include numeric raw/eligible/withheld';
  }
  if (typeof artifact.hostSummary !== 'string' || artifact.hostSummary.trim() === '') {
    return 'approval.json hostSummary is required';
  }
  return undefined;
}

/**
 * Manually reviewed boards ship sanitized identity/jobs fixtures and a small
 * approval artifact. API-probed boards are official sources but intentionally
 * enter the ownership-review queue after publication; their live identity,
 * schema, and host gates remain fail-closed at runtime.
 */
const REQUIRED_FIXTURES: Array<{
  file: string;
  validate: (raw: unknown, source: ReviewedGreenhouseSource) => string | undefined;
}> = [
  { file: 'identity.json', validate: identityFixtureError },
  { file: 'jobs.json', validate: jobsFixtureError },
  { file: 'approval.json', validate: approvalArtifactError },
];

/** `now` is injected so the empty-board acknowledgement age stays testable. */
export function collectManifestViolations(
  registry: ReviewedGreenhouseSource[],
  fs: ManifestFs,
  root: string = GREENHOUSE_FIXTURE_ROOT,
  now: Date = new Date(),
): string[] {
  const violations: string[] = [];
  const unclaimedDirs = new Set(fs.listBoardDirs(root));
  for (const source of registry) {
    unclaimedDirs.delete(source.boardToken);
    if (source.emptyBoardAcknowledged) {
      for (const issue of emptyBoardAcknowledgementViolations(source.emptyBoardAcknowledged, now)) violations.push(`${source.id}: ${issue}`);
    }
    if (source.evidenceStatus === 'api-probed') continue;
    const dir = `${root}/${source.boardToken}`;
    const missing = REQUIRED_FIXTURES.filter(({ file }) => !fs.fileExists(`${dir}/${file}`));
    for (const { file } of missing) violations.push(`${source.id}: missing ${file}`);
    if (missing.length) continue;
    for (const { file, validate } of REQUIRED_FIXTURES) {
      let raw: unknown;
      try {
        raw = fs.readJson(`${dir}/${file}`);
      } catch {
        violations.push(`${source.id}: ${file} is not valid JSON`);
        continue;
      }
      const error = validate(raw, source);
      if (error) violations.push(`${source.id}: ${error}`);
    }
  }
  for (const orphan of unclaimedDirs) {
    violations.push(`fixture directory ${JSON.stringify(orphan)} has no matching reviewed source`);
  }
  return violations;
}

export function nodeManifestFs(): ManifestFs {
  return {
    listBoardDirs: (root) =>
      existsSync(root)
        ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        : [],
    fileExists: (path) => existsSync(path),
    readJson: (path) => JSON.parse(readFileSync(path, 'utf8')),
  };
}
