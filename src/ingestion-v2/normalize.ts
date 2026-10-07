import { createHash } from 'node:crypto';
import { canonicalApplicationUrl } from '../core/application-url.js';
import type { SourcedPosting } from '../types.js';
import {
  INGESTION_V2_SNAPSHOT_SCHEMA_VERSION,
  type NormalizedSnapshotEnvelope,
  type NormalizedSnapshotRow,
} from './types.js';

/**
 * A stable JSON encoding: object keys are sorted and `undefined` values are
 * dropped, so two structurally identical values always serialize identically.
 * Arrays keep their order because source-declared order is material.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function materialHashFor(posting: SourcedPosting): string {
  return createHash('sha256').update(stableStringify(materialView(posting))).digest('hex');
}

/**
 * The exact source-owned facts that make a row materially different.
 *
 * Row number and fetch timestamp are omitted: a maintainer reordering a
 * Markdown table or re-running a poll must not look like a content change.
 */
function materialView(posting: SourcedPosting) {
  let applyUrl = posting.applyUrl;
  try { applyUrl = canonicalApplicationUrl(applyUrl); } catch { /* Malformed URLs are rejected by admission. */ }
  return {
    provenance: posting.provenance,
    document: posting.document ?? posting.externalId,
    sourceUrl: posting.sourceUrl,
    employer: {
      id: posting.employer.id,
      name: posting.employer.name,
      authority: posting.employer.authority,
      labelOrigin: posting.employer.labelOrigin,
      inheritance: posting.employer.inheritance,
    },
    title: posting.title,
    content: posting.content.map((part) => ({ kind: part.kind, format: part.format, value: part.value })),
    locations: posting.locations,
    applyUrl,
    hostedUrl: posting.hostedUrl,
    sourceState: posting.sourceState,
    lifecycleAuthority: posting.lifecycleAuthority,
    publishedAt: posting.publishedAt,
    providerTimestamp: posting.providerTimestamp,
    seasonHint: posting.seasonHint,
    seasonHintAuthority: posting.seasonHintAuthority,
    classificationTags: posting.classificationTags,
    declaredWorkMode: posting.declaredWorkMode,
    compensationText: posting.compensationText,
    compensationBands: posting.compensationBands,
    declaredRequirements: posting.declaredRequirements,
    providerIdentity: posting.providerIdentity,
    providerEvidence: posting.providerEvidence,
  };
}

/**
 * Rebuild the posting with a fixed key order so identical source content always
 * produces byte-identical stored JSON. Volatile fetch metadata is retained for
 * later admission but is excluded from the material hash above.
 */
function canonicalPosting(posting: SourcedPosting): SourcedPosting {
  return {
    sourceId: posting.sourceId,
    ...(posting.provenance !== undefined ? { provenance: posting.provenance } : {}),
    externalId: posting.externalId,
    sourceUrl: posting.sourceUrl,
    ...(posting.document !== undefined ? { document: posting.document } : {}),
    ...(posting.row !== undefined ? { row: posting.row } : {}),
    fetchedAt: posting.fetchedAt,
    employer: {
      ...(posting.employer.id !== undefined ? { id: posting.employer.id } : {}),
      name: posting.employer.name,
      authority: posting.employer.authority,
      ...(posting.employer.labelOrigin !== undefined ? { labelOrigin: posting.employer.labelOrigin } : {}),
      ...(posting.employer.inheritance !== undefined ? { inheritance: posting.employer.inheritance } : {}),
    },
    ...(posting.providerIdentity !== undefined ? { providerIdentity: posting.providerIdentity } : {}),
    title: posting.title,
    content: posting.content.map((part) => ({ kind: part.kind, format: part.format, value: part.value })),
    locations: [...posting.locations],
    applyUrl: posting.applyUrl,
    ...(posting.hostedUrl !== undefined ? { hostedUrl: posting.hostedUrl } : {}),
    ...(posting.providerEvidence !== undefined ? { providerEvidence: posting.providerEvidence } : {}),
    sourceState: posting.sourceState,
    ...(posting.lifecycleAuthority !== undefined ? { lifecycleAuthority: posting.lifecycleAuthority } : {}),
    ...(posting.publishedAt !== undefined ? { publishedAt: posting.publishedAt } : {}),
    ...(posting.providerTimestamp !== undefined ? { providerTimestamp: posting.providerTimestamp } : {}),
    ...(posting.seasonHint !== undefined ? { seasonHint: posting.seasonHint } : {}),
    ...(posting.seasonHintAuthority !== undefined ? { seasonHintAuthority: posting.seasonHintAuthority } : {}),
    ...(posting.classificationTags !== undefined ? { classificationTags: [...posting.classificationTags] } : {}),
    ...(posting.declaredWorkMode !== undefined ? { declaredWorkMode: posting.declaredWorkMode } : {}),
    ...(posting.compensationText !== undefined ? { compensationText: posting.compensationText } : {}),
    ...(posting.compensationBands !== undefined ? { compensationBands: posting.compensationBands.map((band) => ({ ...band })) } : {}),
    ...(posting.declaredRequirements !== undefined ? { declaredRequirements: { ...posting.declaredRequirements } } : {}),
  };
}

/** Exact serialized row capacity without computing a second material hash. */
export function snapshotPostingByteLength(posting: SourcedPosting): number {
  return new TextEncoder().encode(JSON.stringify({ externalId: posting.externalId,
    document: posting.document ?? posting.externalId, row: posting.row ?? 0,
    materialHash: '0'.repeat(64), posting: canonicalPosting(posting),
    firstObservationEligible: posting.sourceState === 'open',
  })).byteLength;
}

function firstObservationEligible(posting: SourcedPosting): boolean {
  return posting.sourceState === 'open';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Normalize one complete source board into the provider-independent snapshot
 * format. The hash is deterministic for identical normalized content and
 * independent of row or document ordering.
 */
export function normalizeSourceSnapshot(input: {
  sourceId: string;
  postings: readonly SourcedPosting[];
  admissionVersion: string;
  observedAt: string;
}): NormalizedSnapshotEnvelope {
  const rowsByExternalId = new Map<string, NormalizedSnapshotRow>();
  for (const posting of input.postings) {
    if (!posting.externalId) continue;
    const normalized: NormalizedSnapshotRow = {
      externalId: posting.externalId,
      document: posting.document ?? posting.externalId,
      row: posting.row ?? 0,
      materialHash: materialHashFor(posting),
      posting: canonicalPosting(posting),
      firstObservationEligible: firstObservationEligible(posting),
    };
    const existing = rowsByExternalId.get(posting.externalId);
    if (existing && existing.materialHash !== normalized.materialHash) {
      throw new Error(`Conflicting duplicate ingestion external ID: ${posting.externalId}`);
    }
    // Exact/materially equivalent duplicates can appear in more than one source
    // document. Pick their bytewise canonical representative so input ordering
    // can never change the retained snapshot body or hash.
    // Only duplicates need a bytewise tie-break. Retaining serialized copies
    // of every posting doubles the large-board working set for no benefit.
    if (!existing || stableStringify(normalized) < stableStringify(existing)) {
      rowsByExternalId.set(posting.externalId, normalized);
    }
  }
  const rows = [...rowsByExternalId.values()];
  rows.sort((left, right) => left.externalId.localeCompare(right.externalId));
  return {
    schemaVersion: INGESTION_V2_SNAPSHOT_SCHEMA_VERSION,
    sourceId: input.sourceId,
    snapshotHash: snapshotHashForRowsAndAdmissionVersion(rows, input.admissionVersion),
    admissionVersion: input.admissionVersion,
    documentCount: new Set(rows.map((row) => row.document)).size,
    rowCount: rows.length,
    observedAt: input.observedAt,
    rows,
  };
}

/** Hash the sorted `(externalId, materialHash)` pairs, never the volatile body. */
export function snapshotHashForRows(rows: readonly { externalId: string; materialHash: string }[]): string {
  const hash = createHash('sha256');
  updateCanonicalHashRows(hash, canonicalHashRows(rows));
  return hash.digest('hex');
}

/**
 * Schema 2 binds the immutable object identity to both source content and the
 * evaluator policy that will interpret it. Schema 1 objects remain readable
 * through `snapshotHashForRows` so in-flight pre-cutover messages can drain.
 */
export function snapshotHashForRowsAndAdmissionVersion(
  rows: readonly { externalId: string; materialHash: string }[],
  admissionVersion: string,
): string {
  const hash = createHash('sha256');
  hash.update(`{"admissionVersion":${JSON.stringify(admissionVersion)},"rows":`);
  updateCanonicalHashRows(hash, canonicalHashRows(rows));
  hash.update('}');
  return hash.digest('hex');
}

type SnapshotHashRow = { externalId: string; materialHash: string };

/** Keep normalized rows zero-copy while retaining deterministic hashes for arbitrary callers. */
function canonicalHashRows(rows: readonly SnapshotHashRow[]): readonly SnapshotHashRow[] {
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1]!.externalId.localeCompare(rows[index]!.externalId) > 0) {
      return [...rows].sort((left, right) => left.externalId.localeCompare(right.externalId));
    }
  }
  return rows;
}

/** Stream the exact stableStringify representation to avoid one whole-board JSON string. */
function updateCanonicalHashRows(
  hash: ReturnType<typeof createHash>,
  rows: readonly SnapshotHashRow[],
): void {
  hash.update('[');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (index > 0) hash.update(',');
    hash.update(`{"externalId":${JSON.stringify(row.externalId)},"materialHash":${JSON.stringify(row.materialHash)}}`);
  }
  hash.update(']');
}

/**
 * Content-addressed R2 key for a source snapshot. Source IDs and hashes are
 * constrained so a snapshot can never escape its prefix.
 */
export function snapshotObjectKey(sourceId: string, snapshotHash: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(sourceId)) throw new Error(`Invalid ingestion source id: ${sourceId}`);
  if (!/^[a-f0-9]{64}$/u.test(snapshotHash)) throw new Error(`Invalid ingestion snapshot hash: ${snapshotHash}`);
  return `ingestion-v2/snapshots/${sourceId}/${snapshotHash}.json`;
}

export function serializeEnvelope(envelope: NormalizedSnapshotEnvelope): string {
  return stableStringify(envelope);
}

/**
 * Validate an envelope read back from object storage. Both the schema version
 * and the content hash must match the recomputed value, so a truncated or
 * tampered object can never be trusted.
 *
 * Cost note (Stage 3): validation walks and re-hashes every row of the whole
 * board. Because a message carries at most 25 IDs, a board of N rows does
 * ~N/25 full-board reads and re-hashes. Integrity is deliberately strict here;
 * Stage 3 should carry a per-batch slice (or a validated per-hash index) so the
 * hot path stops re-validating rows it will not evaluate.
 */
export function parseEnvelope(raw: string, expected: { sourceId: string; snapshotHash: string }): NormalizedSnapshotEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Ingestion snapshot is not valid JSON');
  }
  if (!isRecord(parsed)) throw new Error('Ingestion snapshot envelope is malformed');
  const envelope = parsed as unknown as NormalizedSnapshotEnvelope;
  validateSnapshotHeader(parsed, expected);
  if (!Array.isArray(envelope.rows)) throw new Error('Ingestion snapshot rows are missing');
  if (envelope.rowCount !== envelope.rows.length) throw new Error('Ingestion snapshot row count mismatch');
  const externalIds = new Set<string>();
  let previousExternalId: string | undefined;
  for (const row of envelope.rows) {
    validateSnapshotRow(row, envelope.sourceId);
    if (externalIds.has(row.externalId)) throw new Error('Ingestion snapshot external IDs are not unique');
    if (previousExternalId !== undefined && previousExternalId.localeCompare(row.externalId) >= 0) {
      throw new Error('Ingestion snapshot rows are not canonically ordered');
    }
    externalIds.add(row.externalId);
    previousExternalId = row.externalId;
  }
  if (envelope.documentCount !== new Set(envelope.rows.map((row) => row.document)).size) {
    throw new Error('Ingestion snapshot document count mismatch');
  }
  const recomputed = envelope.schemaVersion === 1
    ? snapshotHashForRows(envelope.rows)
    : snapshotHashForRowsAndAdmissionVersion(envelope.rows, envelope.admissionVersion);
  if (recomputed !== envelope.snapshotHash) throw new Error('Ingestion snapshot hash mismatch');
  return envelope;
}

/** Shared by full-envelope and streaming readers; header order is immaterial. */
export function validateSnapshotHeader(
  envelope: Record<string, unknown>, expected: { sourceId: string; snapshotHash: string },
): asserts envelope is Record<string, unknown> & Omit<NormalizedSnapshotEnvelope, 'rows'> {
  if (envelope.schemaVersion !== 1 && envelope.schemaVersion !== INGESTION_V2_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Unsupported ingestion snapshot schema ${String(envelope.schemaVersion)}`);
  }
  if (envelope.sourceId !== expected.sourceId) throw new Error('Ingestion snapshot source mismatch');
  if (envelope.snapshotHash !== expected.snapshotHash) throw new Error('Ingestion snapshot key mismatch');
  if (typeof envelope.admissionVersion !== 'string' || !envelope.admissionVersion) {
    throw new Error('Ingestion snapshot admission version is malformed');
  }
  if (!validNonNegativeInteger(envelope.documentCount) || !validNonNegativeInteger(envelope.rowCount)) {
    throw new Error('Ingestion snapshot counts are malformed');
  }
  if (typeof envelope.observedAt !== 'string' || !Number.isFinite(Date.parse(envelope.observedAt))) {
    throw new Error('Ingestion snapshot observation time is malformed');
  }
}

/** Validate every material posting fact even for rows not selected for admission. */
export function validateSnapshotRow(value: unknown, sourceId: string): asserts value is NormalizedSnapshotRow {
  const row = value as NormalizedSnapshotRow;
  if (!isRecord(row) || typeof row.externalId !== 'string' || !row.externalId || !isRecord(row.posting)) {
    throw new Error('Ingestion snapshot row is malformed');
  }
  if (typeof row.document !== 'string' || !row.document || !validNonNegativeInteger(row.row)) {
    throw new Error('Ingestion snapshot row location is malformed');
  }
  if (!/^[a-f0-9]{64}$/u.test(row.materialHash)) throw new Error('Ingestion snapshot row material hash is malformed');
  if (row.posting.sourceId !== sourceId) throw new Error('Ingestion snapshot posting source mismatch');
  if (row.posting.externalId !== row.externalId) throw new Error('Ingestion snapshot row identity mismatch');
  if ((row.posting.document ?? row.externalId) !== row.document || (row.posting.row ?? 0) !== row.row) {
    throw new Error('Ingestion snapshot row provenance mismatch');
  }
  if (row.firstObservationEligible !== firstObservationEligible(row.posting)) {
    throw new Error('Ingestion snapshot first-observation eligibility mismatch');
  }
  if (materialHashFor(row.posting) !== row.materialHash) throw new Error('Ingestion snapshot row material mismatch');
}
