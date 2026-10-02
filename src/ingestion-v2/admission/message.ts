import { createHash } from 'node:crypto';
import {
  ADMISSION_V2_MAX_EXTERNAL_IDS,
  ADMISSION_V2_MESSAGE_VERSION,
  type AdmissionMessageValidation,
  type AdmissionV2Message,
} from './types.js';

/**
 * Deterministic batch identity. The same source, snapshot, policy version,
 * baseline mode, and ordered IDs always produce the same batch ID, so a
 * repeated producer run cannot create duplicate logical work and a duplicate
 * delivery is trivially recognizable.
 */
export function admissionV2BatchId(input: {
  sourceId: string;
  snapshotHash: string;
  admissionVersion: string;
  baseline: boolean;
  externalIds: readonly string[];
}): string {
  const ordered = canonicalExternalIds(input.externalIds);
  return createHash('sha256').update([
    'admission-v2',
    input.sourceId,
    input.snapshotHash,
    input.admissionVersion,
    input.baseline ? 'baseline' : 'incremental',
    ordered.join(','),
  ].join('|')).digest('hex');
}

/** Deduplicate and canonically order external IDs (lexicographic ascending). */
export function canonicalExternalIds(externalIds: readonly string[]): string[] {
  return [...new Set(externalIds.filter((id) => typeof id === 'string' && id.length > 0))]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validate an untrusted queue body. Rejects unknown versions, missing
 * references, unordered or duplicated IDs, and over-limit batches. The batch ID
 * is recomputed so a tampered message cannot claim another batch's identity.
 */
export function validateAdmissionV2Message(value: unknown): AdmissionMessageValidation {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'not-an-object' };
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== ADMISSION_V2_MESSAGE_VERSION) return { ok: false, reason: 'unsupported-version' };
  if (!isNonEmptyString(candidate.batchId)) return { ok: false, reason: 'missing-batch-id' };
  if (!isNonEmptyString(candidate.sourceId)) return { ok: false, reason: 'missing-source-id' };
  if (!isNonEmptyString(candidate.snapshotHash)) return { ok: false, reason: 'missing-snapshot-hash' };
  if (!isNonEmptyString(candidate.snapshotKey)) return { ok: false, reason: 'missing-snapshot-key' };
  if (!isNonEmptyString(candidate.admissionVersion)) return { ok: false, reason: 'missing-admission-version' };
  if (typeof candidate.baseline !== 'boolean') return { ok: false, reason: 'missing-baseline' };
  if (!Array.isArray(candidate.externalIds)) return { ok: false, reason: 'missing-external-ids' };
  const externalIds = candidate.externalIds;
  if (externalIds.length === 0) return { ok: false, reason: 'empty-external-ids' };
  if (externalIds.length > ADMISSION_V2_MAX_EXTERNAL_IDS) return { ok: false, reason: 'too-many-external-ids' };
  if (externalIds.some((id) => !isNonEmptyString(id))) return { ok: false, reason: 'invalid-external-id' };
  if (new Set(externalIds).size !== externalIds.length) return { ok: false, reason: 'duplicate-external-id' };
  const ordered = canonicalExternalIds(externalIds);
  if (ordered.join('\u0000') !== (externalIds as string[]).join('\u0000')) {
    return { ok: false, reason: 'non-canonical-order' };
  }
  const expectedBatchId = admissionV2BatchId({
    sourceId: candidate.sourceId,
    snapshotHash: candidate.snapshotHash,
    admissionVersion: candidate.admissionVersion,
    baseline: candidate.baseline,
    externalIds: ordered,
  });
  if (candidate.batchId !== expectedBatchId) return { ok: false, reason: 'batch-id-mismatch' };
  return {
    ok: true,
    message: {
      version: ADMISSION_V2_MESSAGE_VERSION,
      batchId: candidate.batchId,
      sourceId: candidate.sourceId,
      snapshotHash: candidate.snapshotHash,
      snapshotKey: candidate.snapshotKey,
      admissionVersion: candidate.admissionVersion,
      externalIds: ordered,
      baseline: candidate.baseline,
    },
  };
}

/**
 * Deterministically partition actionable IDs into bounded messages. The result
 * depends only on the canonical ordering, so partitioning the same IDs into a
 * single run or across resumed runs yields identical batches.
 */
export function buildAdmissionV2Messages(input: {
  sourceId: string;
  snapshotHash: string;
  snapshotKey: string;
  admissionVersion: string;
  baseline: boolean;
  externalIds: readonly string[];
  maxIds?: number;
}): AdmissionV2Message[] {
  const maxIds = Math.max(1, Math.min(input.maxIds ?? ADMISSION_V2_MAX_EXTERNAL_IDS, ADMISSION_V2_MAX_EXTERNAL_IDS));
  const ordered = canonicalExternalIds(input.externalIds);
  const messages: AdmissionV2Message[] = [];
  for (let offset = 0; offset < ordered.length; offset += maxIds) {
    const externalIds = ordered.slice(offset, offset + maxIds);
    messages.push({
      version: ADMISSION_V2_MESSAGE_VERSION,
      batchId: admissionV2BatchId({
        sourceId: input.sourceId,
        snapshotHash: input.snapshotHash,
        admissionVersion: input.admissionVersion,
        baseline: input.baseline,
        externalIds,
      }),
      sourceId: input.sourceId,
      snapshotHash: input.snapshotHash,
      snapshotKey: input.snapshotKey,
      admissionVersion: input.admissionVersion,
      externalIds,
      baseline: input.baseline,
    });
  }
  return messages;
}
