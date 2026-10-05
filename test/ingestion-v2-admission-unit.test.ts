import { describe, expect, it } from 'vitest';
import {
  admissionV2BatchId,
  buildAdmissionV2Messages,
  canonicalExternalIds,
  validateAdmissionV2Message,
} from '../src/ingestion-v2/admission/message.js';
import { admissionShouldNotify } from '../src/ingestion-v2/admission/migration.js';
import {
  AdmissionInfrastructureError,
  AdmissionRowTransientError,
  classifyAdmissionFailure,
  nextAdmissionAttempt,
} from '../src/ingestion-v2/admission/taxonomy.js';
import { canTransition, planRowTransition } from '../src/ingestion-v2/admission/transitions.js';
import { admissionRowShouldNotify } from '../src/ingestion-v2/admission/evaluator.js';
import {
  ADMISSION_V2_MAX_EXTERNAL_IDS,
  admissionV2FeatureConfig,
  admissionV2OwnsCatalogWrites,
  admissionV2TrustedCommunityAlertsAllowed,
  type AdmissionV2Message,
} from '../src/ingestion-v2/admission/types.js';
import type { IngestionRowRecord } from '../src/ingestion-v2/types.js';

function message(overrides: Partial<AdmissionV2Message> = {}): AdmissionV2Message {
  const externalIds = overrides.externalIds ?? ['a'];
  const sourceId = overrides.sourceId ?? 'community-example';
  const snapshotHash = overrides.snapshotHash ?? 's'.repeat(64);
  const admissionVersion = overrides.admissionVersion ?? 'standard-v1';
  const baseline = overrides.baseline ?? false;
  return {
    version: 1,
    batchId: overrides.batchId ?? admissionV2BatchId({ sourceId, snapshotHash, admissionVersion, baseline, externalIds }),
    sourceId,
    snapshotHash,
    snapshotKey: overrides.snapshotKey ?? `ingestion-v2/snapshots/${sourceId}/${snapshotHash}.json`,
    admissionVersion,
    externalIds,
    baseline,
  };
}

describe('admission v2 message contract', () => {
  it('canonically orders and deduplicates external ids', () => {
    expect(canonicalExternalIds(['b', 'a', 'b', '', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('builds deterministic batch ids independent of input order', () => {
    const first = admissionV2BatchId({ sourceId: 's', snapshotHash: 'h', admissionVersion: 'v', baseline: false, externalIds: ['b', 'a'] });
    const second = admissionV2BatchId({ sourceId: 's', snapshotHash: 'h', admissionVersion: 'v', baseline: false, externalIds: ['a', 'b'] });
    expect(first).toBe(second);
    expect(admissionV2BatchId({ sourceId: 's', snapshotHash: 'h', admissionVersion: 'v', baseline: true, externalIds: ['a', 'b'] })).not.toBe(first);
  });

  it('partitions deterministically into batches of at most 25', () => {
    const ids = Array.from({ length: 60 }, (_, index) => `id-${String(index).padStart(2, '0')}`);
    const messages = buildAdmissionV2Messages({ sourceId: 's', snapshotHash: 'h', snapshotKey: 'k', admissionVersion: 'v', baseline: false, externalIds: ids });
    expect(messages.map((entry) => entry.externalIds.length)).toEqual([25, 25, 10]);
    expect(messages.every((entry) => entry.externalIds.length <= ADMISSION_V2_MAX_EXTERNAL_IDS)).toBe(true);
    expect(messages.map((entry) => entry.externalIds).flat()).toEqual([...ids].sort());
  });

  it('validates a well-formed message', () => {
    const validated = validateAdmissionV2Message(message());
    expect(validated.ok).toBe(true);
  });

  it('rejects malformed, unordered, oversized, and tampered messages', () => {
    expect(validateAdmissionV2Message(null)).toEqual({ ok: false, reason: 'not-an-object' });
    expect(validateAdmissionV2Message({ ...message(), version: 2 })).toEqual({ ok: false, reason: 'unsupported-version' });
    expect(validateAdmissionV2Message({ ...message(), externalIds: [] })).toEqual({ ok: false, reason: 'empty-external-ids' });
    expect(validateAdmissionV2Message({ ...message(), externalIds: ['b', 'a'] })).toEqual({ ok: false, reason: 'non-canonical-order' });
    expect(validateAdmissionV2Message({ ...message(), externalIds: ['a', 'a'] })).toEqual({ ok: false, reason: 'duplicate-external-id' });
    expect(validateAdmissionV2Message({ ...message(), externalIds: Array.from({ length: 26 }, (_, i) => `id-${i}`) }))
      .toEqual({ ok: false, reason: 'too-many-external-ids' });
    expect(validateAdmissionV2Message({ ...message(), batchId: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'batch-id-mismatch' });
  });
});

describe('admission v2 failure taxonomy', () => {
  it('classifies explicit transient and infrastructure errors', () => {
    expect(classifyAdmissionFailure(new AdmissionRowTransientError('destination-rate-limited', '429')))
      .toEqual({ kind: 'row-transient', classification: 'destination-rate-limited', detail: '429' });
    expect(classifyAdmissionFailure(new AdmissionInfrastructureError('snapshot-missing', 'gone')))
      .toEqual({ kind: 'infrastructure', classification: 'snapshot-missing', detail: 'gone' });
  });

  it('classifies unknown errors as infrastructure so ambiguity never quarantines', () => {
    expect(classifyAdmissionFailure(new Error('something odd'))).toMatchObject({ kind: 'infrastructure', classification: 'internal' });
  });

  it('classifies destination signals and D1 failures', () => {
    expect(classifyAdmissionFailure(new Error('request timed out'))).toMatchObject({ kind: 'row-transient', classification: 'destination-timeout' });
    expect(classifyAdmissionFailure(new Error('HTTP 503 upstream'))).toMatchObject({ kind: 'row-transient', classification: 'upstream-server-error' });
    expect(classifyAdmissionFailure(new Error('D1_ERROR: connection lost'))).toMatchObject({ kind: 'infrastructure', classification: 'd1-unavailable' });
    expect(classifyAdmissionFailure(new Error('D1_ERROR: query timed out'))).toMatchObject({ kind: 'infrastructure', classification: 'd1-unavailable' });
    expect(classifyAdmissionFailure(new Error('database unavailable (503)'))).toMatchObject({ kind: 'infrastructure', classification: 'd1-unavailable' });
    expect(classifyAdmissionFailure(new Error('SQL storage aborted'))).toMatchObject({ kind: 'infrastructure', classification: 'd1-unavailable' });
    expect(classifyAdmissionFailure(new Error('Ingestion snapshot object missing at key'))).toMatchObject({ kind: 'infrastructure', classification: 'snapshot-missing' });
  });

  it('schedules exactly two row-local retries before exhaustion', () => {
    const now = Date.parse('2026-10-01T00:00:00.000Z');
    expect(nextAdmissionAttempt(1, now)).toEqual({ retryAt: '2026-10-01T00:01:00.000Z', attemptCount: 1 });
    expect(nextAdmissionAttempt(2, now)).toEqual({ retryAt: '2026-10-01T00:05:00.000Z', attemptCount: 2 });
    expect(nextAdmissionAttempt(3, now)).toEqual({ exhausted: true, attemptCount: 3 });
  });
});

describe('admission v2 row transitions', () => {
  it('permits the documented transitions and rejects illegal ones', () => {
    expect(planRowTransition('pending', 'dispatch')).toEqual({ ok: true, plan: { from: 'pending', event: 'dispatch', to: 'queued' } });
    expect(planRowTransition('queued', 'lease')).toMatchObject({ ok: true, plan: { to: 'processing' } });
    expect(planRowTransition('processing', 'settle')).toMatchObject({ ok: true, plan: { to: 'settled' } });
    expect(planRowTransition('processing', 'retry')).toMatchObject({ ok: true, plan: { to: 'queued' } });
    expect(planRowTransition('processing', 'quarantine')).toMatchObject({ ok: true, plan: { to: 'quarantined' } });
    expect(planRowTransition('quarantined', 'reopen')).toMatchObject({ ok: true, plan: { to: 'queued' } });
    expect(planRowTransition('settled', 'lease')).toMatchObject({ ok: false });
    expect(planRowTransition('processing', 'dispatch')).toMatchObject({ ok: false });
    expect(canTransition('absent', 'quarantined')).toBe(false);
  });
});

describe('admission v2 notification fencing', () => {
  it('silences baseline and policy-migration work', () => {
    expect(admissionShouldNotify({ baseline: true, policyMigration: false, firstObservation: true, existingJob: false })).toBe(false);
    expect(admissionShouldNotify({ baseline: false, policyMigration: true, firstObservation: true, existingJob: false })).toBe(false);
  });

  it('only notifies a genuinely new post-baseline role', () => {
    expect(admissionShouldNotify({ baseline: false, policyMigration: false, firstObservation: true, existingJob: false })).toBe(true);
    expect(admissionShouldNotify({ baseline: false, policyMigration: false, firstObservation: false, existingJob: false })).toBe(false);
    expect(admissionShouldNotify({ baseline: false, policyMigration: false, firstObservation: true, existingJob: true })).toBe(false);
  });

  function fencingRow(overrides: Partial<IngestionRowRecord> = {}): IngestionRowRecord {
    return {
      sourceId: 'community-example', externalId: 'a', snapshotHash: 's', materialHash: 'm', admissionVersion: 'v',
      state: 'processing', attemptCount: 0, consecutiveOmissions: 0,
      firstObservedAt: 't', lastObservedAt: 't', updatedAt: 't', ...overrides,
    };
  }

  it('derives the commit notification decision from baseline and prior job identity', () => {
    expect(admissionRowShouldNotify({ baseline: false, row: fencingRow(), firstObservationEligible: true })).toBe(true);
    // Baseline work is silent even for a brand-new row.
    expect(admissionRowShouldNotify({ baseline: true, row: fencingRow(), firstObservationEligible: true })).toBe(false);
    // A row that already owns a catalog job (policy migration/re-admission) is silent.
    expect(admissionRowShouldNotify({ baseline: false, row: fencingRow({ jobId: 'JOB#1' }), firstObservationEligible: true })).toBe(false);
    // A closed/prospect row is never first-observation eligible.
    expect(admissionRowShouldNotify({ baseline: false, row: fencingRow(), firstObservationEligible: false })).toBe(false);
    // Policy-migration work is silent even without a recorded job.
    expect(admissionRowShouldNotify({ baseline: false, row: fencingRow(), firstObservationEligible: true }, { policyMigration: true })).toBe(false);
  });
});

describe('admission v2 Stage 3 writer controls', () => {
  it('keeps live effects off by default', () => {
    expect(admissionV2FeatureConfig({})).toMatchObject({
      admissionEnabled: false,
      catalogWriterEnabled: false,
    });
  });

  it('transfers legacy ownership only when discovery, admission, writer, and every source gate match', () => {
    const enabled = {
      INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true',
      INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: 'canary',
      INGESTION_V2_ADMISSION_ENABLED: 'true',
      INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: 'canary',
      INGESTION_V2_CATALOG_WRITER_ENABLED: 'true',
      INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST: 'canary',
      INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: 'canary',
      INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST: 'canary',
    };
    expect(admissionV2OwnsCatalogWrites(enabled, 'canary')).toBe(true);
    expect(admissionV2OwnsCatalogWrites({ ...enabled, INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: '' }, 'canary')).toBe(false);
    expect(admissionV2OwnsCatalogWrites({ ...enabled, INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: '' }, 'canary')).toBe(false);
    expect(admissionV2OwnsCatalogWrites({ ...enabled, INGESTION_V2_CATALOG_WRITER_ENABLED: 'false' }, 'canary')).toBe(false);
    expect(admissionV2OwnsCatalogWrites({ ...enabled, INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: '' }, 'canary')).toBe(false);
    expect(admissionV2TrustedCommunityAlertsAllowed(enabled, 'canary')).toBe(true);
    expect(admissionV2TrustedCommunityAlertsAllowed({ ...enabled, INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST: '' }, 'canary')).toBe(false);
  });
});
