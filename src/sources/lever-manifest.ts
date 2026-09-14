/**
 * Registry-to-evidence manifest gate for Lever, mirroring
 * `collectLeverManifestViolations`'s Greenhouse counterpart.
 *
 * The agent proposes and the probe measures, but neither can admit a board. This
 * is the deterministic step that decides whether what was committed actually
 * supports what the registry claims — and it is the step that runs again every
 * time, long after the agent's session is gone.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { admissibleLeverEvidence, evidenceViolations, LEVER_ADMISSIBLE_OWNERSHIP_STATES, type LeverOwnershipEvidence } from './lever-evidence.js';
import { reviewedLeverSources, type ReviewedLeverSource } from './lever-config.js';
import { sourceQualityPolicies, type SourceQualityPolicy } from './quality.js';
import { emptyBoardAcknowledgementViolations } from './reviewed-source.js';

export const LEVER_EVIDENCE_ROOT = 'test/fixtures/lever';
export const LEVER_REVERIFICATION_DAYS = 180;
const DAY_MS = 86_400_000;

export interface LeverManifestFs {
  listSiteDirs(root: string): string[];
  fileExists(path: string): boolean;
  readJson(path: string): unknown;
}

export function nodeLeverManifestFs(): LeverManifestFs {
  return {
    listSiteDirs: (root) => existsSync(root)
      ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : [],
    fileExists: (path) => existsSync(path),
    readJson: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
  };
}

export interface LeverManifestOptions {
  fs: LeverManifestFs;
  root?: string;
  now?: Date;
  policies?: SourceQualityPolicy[];
}

function daysSince(iso: string, now: Date): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : Math.floor((now.getTime() - parsed) / DAY_MS);
}

function readEvidence(fs: LeverManifestFs, path: string): LeverOwnershipEvidence | string {
  try {
    const raw = fs.readJson(path);
    if (!raw || typeof raw !== 'object') return 'is not an evidence object';
    return raw as LeverOwnershipEvidence;
  } catch {
    return 'is not valid JSON';
  }
}

interface LeverProbeArtifact {
  probedAt: string;
  attribution: 'unattributed';
  results: Array<Record<string, unknown>>;
}

function readProbe(fs: LeverManifestFs, path: string): LeverProbeArtifact | string {
  try {
    const raw = fs.readJson(path);
    if (!raw || typeof raw !== 'object') return 'is not a probe artifact';
    const probe = raw as Partial<LeverProbeArtifact>;
    if (Number.isNaN(Date.parse(probe.probedAt ?? ''))) return 'has no parseable probedAt';
    if (probe.attribution !== 'unattributed') return 'does not declare attribution "unattributed"';
    if (!Array.isArray(probe.results) || probe.results.length !== 1 || !probe.results[0] || typeof probe.results[0] !== 'object') {
      return 'must contain exactly one probe result';
    }
    return probe as LeverProbeArtifact;
  } catch {
    return 'is not valid JSON';
  }
}

function probeViolations(
  probe: LeverProbeArtifact,
  site: string,
  requireCleanBoard: boolean,
): string[] {
  const result = probe.results[0];
  const violations: string[] = [];
  if (result.site !== site) violations.push(`probe site ${JSON.stringify(result.site)} does not match ${JSON.stringify(site)}`);
  if (!requireCleanBoard) return violations;
  if (result.state !== 'ok') {
    violations.push(`ownership-verified evidence requires an ok probe, got ${JSON.stringify(result.state)}`);
    return violations;
  }
  if (result.attribution !== 'unattributed') violations.push('ok probe does not declare attribution "unattributed"');
  if (result.region !== 'global') violations.push(`ok probe region is ${JSON.stringify(result.region)}, not "global"`);
  if (result.urlContractViolations !== 0) violations.push(`ok probe reports ${JSON.stringify(result.urlContractViolations)} URL-contract violations`);
  if (result.malformedRows !== 0) violations.push(`ok probe reports ${JSON.stringify(result.malformedRows)} malformed rows`);
  const hosts = result.applicationHostSummary;
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) {
    violations.push('ok probe has no applicationHostSummary');
  } else {
    const unexpectedHosts = Object.keys(hosts).filter((host) => host !== 'jobs.lever.co');
    if (unexpectedHosts.length) violations.push(`ok probe application hosts leave jobs.lever.co (${unexpectedHosts.join(', ')})`);
  }
  return violations;
}

export function collectLeverManifestViolations(
  registry: ReviewedLeverSource[] = reviewedLeverSources,
  options: LeverManifestOptions = { fs: nodeLeverManifestFs() },
): string[] {
  const root = options.root ?? LEVER_EVIDENCE_ROOT;
  const now = options.now ?? new Date();
  const policies = options.policies ?? sourceQualityPolicies;
  const violations: string[] = [];
  const seenIds = new Set<string>();
  const seenSites = new Set<string>();
  const unclaimedDirs = new Set(options.fs.listSiteDirs(root));

  for (const source of registry) {
    if (seenIds.has(source.id)) violations.push(`${source.id}: duplicate source id`);
    if (seenSites.has(source.site)) violations.push(`${source.id}: site ${source.site} is registered twice`);
    seenIds.add(source.id);
    seenSites.add(source.site);
    if (!source.id.startsWith('lever-')) violations.push(`${source.id}: source id must be namespaced lever-*`);
    if (source.emptyBoardAcknowledged) {
      for (const issue of emptyBoardAcknowledgementViolations(source.emptyBoardAcknowledged, now)) violations.push(`${source.id}: ${issue}`);
    }

    // A registry entry with no matching quality policy is a board whose
    // application URLs nothing checks, which is the drift this catches.
    const policy = policies.find((entry) => entry.id === source.id);
    if (!policy) violations.push(`${source.id}: no sourceQualityPolicies entry`);
    else if (policy.sourceClass !== 'lever') violations.push(`${source.id}: quality policy class is ${policy.sourceClass}, not lever`);
    else if (policy.leverSite !== source.site) violations.push(`${source.id}: quality policy site ${JSON.stringify(policy.leverSite)} does not match registry site ${JSON.stringify(source.site)}`);

    const age = daysSince(source.admittedAt, now);
    if (age === undefined) violations.push(`${source.id}: admittedAt is not a parseable date`);
    else if (age > LEVER_REVERIFICATION_DAYS) {
      violations.push(`${source.id}: re-verification overdue — admitted ${source.admittedAt} (${age} days ago, limit ${LEVER_REVERIFICATION_DAYS})`);
    }

    unclaimedDirs.delete(source.site);
    if (source.evidenceStatus === 'legacy-review') continue;

    const evidencePath = `${root}/${source.site}/evidence.json`;
    const probePath = `${root}/${source.site}/probe.json`;
    if (!options.fs.fileExists(evidencePath)) {
      violations.push(`${source.id}: missing ${evidencePath}`);
      continue;
    }
    if (!options.fs.fileExists(probePath)) violations.push(`${source.id}: missing ${probePath}`);
    const evidence = readEvidence(options.fs, evidencePath);
    if (typeof evidence === 'string') {
      violations.push(`${source.id}: evidence.json ${evidence}`);
      continue;
    }
    for (const violation of evidenceViolations(evidence)) violations.push(`${source.id}: ${violation}`);
    if (!LEVER_ADMISSIBLE_OWNERSHIP_STATES.includes(evidence.state)) {
      violations.push(`${source.id}: evidence state ${evidence.state} is not admissible`);
    }
    if (evidence.site !== source.site) violations.push(`${source.id}: evidence site ${evidence.site} does not match registry site ${source.site}`);
    if (evidence.displayName !== source.company) violations.push(`${source.id}: evidence displayName ${JSON.stringify(evidence.displayName)} does not match registry company ${JSON.stringify(source.company)}`);
    if (evidence.careersUrl !== source.careersUrl) violations.push(`${source.id}: evidence careersUrl does not match registry careersUrl`);
    if (evidence.region !== source.region) violations.push(`${source.id}: evidence region ${evidence.region} does not match registry region ${source.region}`);
    if (Date.parse(evidence.verifiedAt) !== Date.parse(source.admittedAt)) {
      violations.push(`${source.id}: evidence verifiedAt ${evidence.verifiedAt} does not match registry admittedAt ${source.admittedAt}`);
    }
    if (options.fs.fileExists(probePath)) {
      const probe = readProbe(options.fs, probePath);
      if (typeof probe === 'string') violations.push(`${source.id}: probe.json ${probe}`);
      else for (const violation of probeViolations(probe, source.site, true)) violations.push(`${source.id}: ${violation}`);
    }
  }

  for (const policy of policies.filter((entry) => entry.sourceClass === 'lever')) {
    if (!registry.some((source) => source.id === policy.id)) {
      violations.push(`quality policy ${policy.id} has no reviewed Lever source`);
    }
  }

  // Evidence directories for candidates that have not been admitted yet are the
  // exception queue, so they are allowed — but every committed record must be
  // well-formed, or the queue rots into a pile of unverifiable claims.
  for (const site of unclaimedDirs) {
    const evidencePath = `${root}/${site}/evidence.json`;
    if (!options.fs.fileExists(evidencePath)) {
      violations.push(`evidence directory ${JSON.stringify(site)} contains no evidence.json`);
      continue;
    }
    const evidence = readEvidence(options.fs, evidencePath);
    if (typeof evidence === 'string') {
      violations.push(`${site}: evidence.json ${evidence}`);
      continue;
    }
    if (evidence.site !== site) violations.push(`${site}: evidence.json declares site ${JSON.stringify(evidence.site)}`);
    for (const violation of evidenceViolations(evidence)) violations.push(`${site}: ${violation}`);
    const probePath = `${root}/${site}/probe.json`;
    if (!options.fs.fileExists(probePath)) {
      violations.push(`${site}: missing ${probePath}`);
      continue;
    }
    const probe = readProbe(options.fs, probePath);
    if (typeof probe === 'string') violations.push(`${site}: probe.json ${probe}`);
    else for (const violation of probeViolations(probe, site, evidence.state === 'ownership-verified')) violations.push(`${site}: ${violation}`);
  }
  return violations;
}

export interface LeverManifestSummary {
  reviewed: number;
  published: number;
  shadow: number;
  agentVerified: number;
  legacyReview: number;
  /** Verified boards sitting in the evidence queue with no registry entry yet. */
  pendingAdmission: string[];
}

export function summariseLeverManifest(
  registry: ReviewedLeverSource[] = reviewedLeverSources,
  options: LeverManifestOptions = { fs: nodeLeverManifestFs() },
): LeverManifestSummary {
  const root = options.root ?? LEVER_EVIDENCE_ROOT;
  const registered = new Set(registry.map((source) => source.site));
  const pendingAdmission = options.fs.listSiteDirs(root).filter((site) => {
    if (registered.has(site)) return false;
    const evidence = readEvidence(options.fs, `${root}/${site}/evidence.json`);
    return typeof evidence !== 'string' && admissibleLeverEvidence(evidence);
  }).sort();
  return {
    reviewed: registry.length,
    published: registry.filter((source) => source.status === 'published').length,
    shadow: registry.filter((source) => source.status === 'shadow').length,
    agentVerified: registry.filter((source) => source.evidenceStatus === 'agent-verified').length,
    legacyReview: registry.filter((source) => source.evidenceStatus === 'legacy-review').length,
    pendingAdmission,
  };
}
