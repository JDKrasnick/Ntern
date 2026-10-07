import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InternshipStore } from '../store.js';
import type { SourceCheckpoint } from '../types.js';
import type { IngestionSnapshotObjectStore } from './types.js';
import type { AdmissionV2Ledger } from './admission/ledger.js';

export const INGESTION_V2_BOOTSTRAP_TOKEN_TTL_MS = 15 * 60_000;

export interface IngestionV2BootstrapReceipt {
  version: 1;
  sourceId: string;
  snapshotHash: string;
  admissionVersion: string;
  activeRows: number;
  actionableRows: number;
  expectedNotifications: 0;
  actor: string;
  appliedAt: string;
  idempotent: boolean;
}

export interface IngestionV2BootstrapRepository extends AdmissionV2Ledger {
  listRowsForSnapshot(sourceId: string, snapshotHash: string, limit: number): Promise<Array<{ externalId: string }>>;
  getBootstrapReceipt(sourceId: string, snapshotHash: string, admissionVersion: string): Promise<IngestionV2BootstrapReceipt | undefined>;
  applyBootstrap(input: {
    sourceId: string;
    snapshotHash: string;
    admissionVersion: string;
    activeRows: number;
    actionableRows: number;
    checkpoint: SourceCheckpoint;
    actor: string;
    appliedAt: string;
    receipt: IngestionV2BootstrapReceipt;
  }): Promise<IngestionV2BootstrapReceipt>;
}

export interface IngestionV2BootstrapPlan {
  version: 1;
  sourceId: string;
  sourceStatus: string;
  checkpoint: {
    admissionConfigurationVersion?: string;
    pendingAdmissionConfigurationVersion?: string;
    pendingResolutionRows: number;
    successfulFetches: number;
  };
  ledger: {
    pending: number;
    queued: number;
    processing: number;
    settled: number;
    quarantined: number;
    absent: number;
  };
  snapshot: {
    hash: string;
    admissionVersion: string;
    rowCount: number;
    documentCount: number;
    objectKey: string;
    complete: true;
  };
  activeRows: number;
  actionableRows: number;
  actionableReasons: { baseline: number };
  historicalRowsExcluded: number;
  legacySuppressedActiveRows: number;
  expectedCatalogVisibilityChanges: number;
  expectedNotifications: 0;
  estimatedWrites: { d1: number; r2: 0 };
  alreadyApplied: boolean;
  expiresAt: string;
  repairToken: string;
}

interface BootstrapDependencies {
  repository: IngestionV2BootstrapRepository;
  snapshots: IngestionSnapshotObjectStore;
  store: InternshipStore;
  secret: string;
  now?: () => Date;
}

function canonicalGuard(plan: Omit<IngestionV2BootstrapPlan, 'repairToken'>): string {
  return JSON.stringify({
    version: plan.version,
    sourceId: plan.sourceId,
    sourceStatus: plan.sourceStatus,
    checkpoint: plan.checkpoint,
    ledger: plan.ledger,
    snapshot: plan.snapshot,
    activeRows: plan.activeRows,
    actionableRows: plan.actionableRows,
    historicalRowsExcluded: plan.historicalRowsExcluded,
    legacySuppressedActiveRows: plan.legacySuppressedActiveRows,
    expectedCatalogVisibilityChanges: plan.expectedCatalogVisibilityChanges,
    expectedNotifications: plan.expectedNotifications,
    estimatedWrites: plan.estimatedWrites,
    alreadyApplied: plan.alreadyApplied,
    expiresAt: plan.expiresAt,
  });
}

function tokenFor(plan: Omit<IngestionV2BootstrapPlan, 'repairToken'>, secret: string): string {
  const expiresAtMs = Date.parse(plan.expiresAt);
  const signature = createHmac('sha256', secret).update(canonicalGuard(plan)).digest('hex');
  return `${expiresAtMs}.${signature}`;
}

function tokensMatch(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function planIngestionV2Bootstrap(
  sourceId: string,
  dependencies: BootstrapDependencies,
): Promise<IngestionV2BootstrapPlan> {
  const now = (dependencies.now ?? (() => new Date()))();
  const [health, checkpoint, overview] = await Promise.all([
    dependencies.store.getSourceHealth(sourceId),
    dependencies.store.getCheckpoint(sourceId),
    dependencies.repository.overview(sourceId),
  ]);
  if (!checkpoint) throw new Error(`Source ${sourceId} has no legacy checkpoint`);
  if (!overview.currentSnapshotHash) throw new Error(`Source ${sourceId} has no active V2 snapshot`);
  const snapshot = await dependencies.repository.getSnapshot(sourceId, overview.currentSnapshotHash);
  if (!snapshot?.isComplete) throw new Error(`Source ${sourceId} has no complete active V2 snapshot`);
  const envelope = await dependencies.snapshots.getSnapshot(sourceId, snapshot.snapshotHash);
  if (envelope.rowCount !== snapshot.rowCount || envelope.admissionVersion !== snapshot.admissionVersion) {
    throw new Error(`Source ${sourceId} snapshot metadata drifted between D1 and R2`);
  }
  const ledgerRows = await dependencies.repository.listRowsForSnapshot(sourceId, snapshot.snapshotHash, envelope.rowCount + 1);
  if (ledgerRows.length !== envelope.rowCount) {
    throw new Error(`Source ${sourceId} active V2 ledger is incomplete: expected ${envelope.rowCount}, found ${ledgerRows.length}`);
  }
  const activeIds = new Set(envelope.rows.map((row) => row.externalId));
  if (ledgerRows.some((row) => !activeIds.has(row.externalId))) {
    throw new Error(`Source ${sourceId} active V2 ledger does not match its retained snapshot`);
  }
  const [selection, priorReceipt] = await Promise.all([
    dependencies.store.listSourceOccurrenceSelectionMetadata(sourceId),
    dependencies.repository.getBootstrapReceipt(sourceId, snapshot.snapshotHash, snapshot.admissionVersion),
  ]);
  const activeLegacy = selection.filter((row) => activeIds.has(row.externalId));
  const legacySuppressedActiveRows = activeLegacy.filter((row) => row.catalogPublicationSuppressed === true).length;
  const alreadyApplied = Boolean(priorReceipt);
  const actionableRows = alreadyApplied ? 0 : envelope.rowCount;
  const expiresAt = new Date(now.getTime() + INGESTION_V2_BOOTSTRAP_TOKEN_TTL_MS).toISOString();
  const unsigned: Omit<IngestionV2BootstrapPlan, 'repairToken'> = {
    version: 1,
    sourceId,
    sourceStatus: health?.sourceStatus ?? 'active',
    checkpoint: {
      ...(checkpoint.admissionConfigurationVersion ? { admissionConfigurationVersion: checkpoint.admissionConfigurationVersion } : {}),
      ...(checkpoint.pendingAdmissionConfigurationVersion ? { pendingAdmissionConfigurationVersion: checkpoint.pendingAdmissionConfigurationVersion } : {}),
      pendingResolutionRows: checkpoint.pendingResolutionRows?.length ?? 0,
      successfulFetches: checkpoint.successfulFetches,
    },
    ledger: {
      pending: overview.pending,
      queued: overview.queued,
      processing: overview.processing,
      settled: overview.settled,
      quarantined: overview.quarantined,
      absent: overview.absent,
    },
    snapshot: {
      hash: snapshot.snapshotHash,
      admissionVersion: snapshot.admissionVersion,
      rowCount: snapshot.rowCount,
      documentCount: snapshot.documentCount,
      objectKey: snapshot.objectKey,
      complete: true,
    },
    activeRows: envelope.rowCount,
    actionableRows,
    actionableReasons: { baseline: actionableRows },
    historicalRowsExcluded: Math.max(0, selection.length - activeLegacy.length),
    legacySuppressedActiveRows,
    expectedCatalogVisibilityChanges: legacySuppressedActiveRows,
    expectedNotifications: 0,
    estimatedWrites: { d1: alreadyApplied ? 0 : envelope.rowCount + 2, r2: 0 },
    alreadyApplied,
    expiresAt,
  };
  return { ...unsigned, repairToken: tokenFor(unsigned, dependencies.secret) };
}

export async function applyIngestionV2Bootstrap(input: {
  sourceId: string;
  repairToken: string;
  expectedActive: number;
  expectedActionable: number;
  actor: string;
}, dependencies: BootstrapDependencies): Promise<IngestionV2BootstrapReceipt> {
  const now = (dependencies.now ?? (() => new Date()))();
  const freshPlan = await planIngestionV2Bootstrap(input.sourceId, { ...dependencies, now: () => now });
  const tokenExpiryMs = Number(input.repairToken.split('.', 1)[0]);
  if (!Number.isSafeInteger(tokenExpiryMs) || tokenExpiryMs <= now.getTime()) throw new Error('Bootstrap guard token expired');
  const { repairToken: freshToken, ...freshUnsigned } = freshPlan;
  if (!freshToken) throw new Error('Bootstrap guard token generation failed');
  const guardedUnsigned = { ...freshUnsigned, expiresAt: new Date(tokenExpiryMs).toISOString() };
  const expectedToken = tokenFor(guardedUnsigned, dependencies.secret);
  if (!tokensMatch(input.repairToken, expectedToken)) throw new Error('Bootstrap guard drifted; run a new dry-run');
  const plan = { ...freshPlan, expiresAt: guardedUnsigned.expiresAt, repairToken: expectedToken };
  if (plan.sourceStatus !== 'paused') throw new Error(`Source ${input.sourceId} must be paused before bootstrap apply`);
  if (plan.ledger.processing > 0 || plan.ledger.queued > 0) {
    throw new Error(`Source ${input.sourceId} still has active admission delivery work`);
  }
  if (input.expectedActive !== plan.activeRows || input.expectedActionable !== plan.actionableRows) {
    throw new Error('Bootstrap expected counts do not match the current plan');
  }
  const existing = await dependencies.repository.getBootstrapReceipt(
    input.sourceId,
    plan.snapshot.hash,
    plan.snapshot.admissionVersion,
  );
  if (existing) return { ...existing, idempotent: true };
  const checkpoint = await dependencies.store.getCheckpoint(input.sourceId);
  if (!checkpoint) throw new Error(`Source ${input.sourceId} has no legacy checkpoint`);
  const nextCheckpoint: SourceCheckpoint = {
    ...checkpoint,
    admissionConfigurationVersion: plan.snapshot.admissionVersion,
    activeExternalIds: (await dependencies.snapshots.getSnapshot(input.sourceId, plan.snapshot.hash)).rows.map((row) => row.externalId),
    pendingAdmissionConfigurationVersion: undefined,
    pendingResolutionRows: undefined,
    pendingResolutionUnvisitedRows: undefined,
  };
  const appliedAt = now.toISOString();
  const receipt: IngestionV2BootstrapReceipt = {
    version: 1,
    sourceId: input.sourceId,
    snapshotHash: plan.snapshot.hash,
    admissionVersion: plan.snapshot.admissionVersion,
    activeRows: plan.activeRows,
    actionableRows: plan.actionableRows,
    expectedNotifications: 0,
    actor: input.actor,
    appliedAt,
    idempotent: false,
  };
  return dependencies.repository.applyBootstrap({
    sourceId: input.sourceId,
    snapshotHash: plan.snapshot.hash,
    admissionVersion: plan.snapshot.admissionVersion,
    activeRows: plan.activeRows,
    actionableRows: plan.actionableRows,
    checkpoint: nextCheckpoint,
    actor: input.actor,
    appliedAt,
    receipt,
  });
}
