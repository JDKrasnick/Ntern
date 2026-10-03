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
    ...(posting.provenance ? { provenance: posting.provenance } : {}),
    externalId: posting.externalId,
    sourceUrl: posting.sourceUrl,
    ...(posting.document !== undefined ? { document: posting.document } : {}),
    ...(posting.row !== undefined ? { row: posting.row } : {}),
    fetchedAt: posting.fetchedAt,
    employer: {
      ...(posting.employer.id !== undefined ? { id: posting.employer.id } : {}),
      name: posting.employer.name,
      authority: posting.employer.authority,
      ...(posting.employer.labelOrigin ? { labelOrigin: posting.employer.labelOrigin } : {}),
      ...(posting.employer.inheritance ? { inheritance: posting.employer.inheritance } : {}),
    },
    ...(posting.providerIdentity ? { providerIdentity: posting.providerIdentity } : {}),
    title: posting.title,
    content: posting.content.map((part) => ({ kind: part.kind, format: part.format, value: part.value })),
    locations: [...posting.locations],
    applyUrl: posting.applyUrl,
    ...(posting.hostedUrl ? { hostedUrl: posting.hostedUrl } : {}),
    ...(posting.providerEvidence ? { providerEvidence: posting.providerEvidence } : {}),
    sourceState: posting.sourceState,
    ...(posting.lifecycleAuthority ? { lifecycleAuthority: posting.lifecycleAuthority } : {}),
    ...(posting.publishedAt ? { publishedAt: posting.publishedAt } : {}),
    ...(posting.providerTimestamp ? { providerTimestamp: posting.providerTimestamp } : {}),
    ...(posting.seasonHint ? { seasonHint: posting.seasonHint } : {}),
    ...(posting.seasonHintAuthority ? { seasonHintAuthority: posting.seasonHintAuthority } : {}),
    ...(posting.classificationTags ? { classificationTags: [...posting.classificationTags] } : {}),
    ...(posting.declaredWorkMode ? { declaredWorkMode: posting.declaredWorkMode } : {}),
    ...(posting.compensationText ? { compensationText: posting.compensationText } : {}),
    ...(posting.compensationBands ? { compensationBands: posting.compensationBands.map((band) => ({ ...band })) } : {}),
    ...(posting.declaredRequirements ? { declaredRequirements: { ...posting.declaredRequirements } } : {}),
  };
}

function firstObservationEligible(posting: SourcedPosting): boolean {
  return posting.sourceState === 'open';
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
  const rowsByExternalId = new Map<string, { row: NormalizedSnapshotRow; canonical: string }>();
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
    const canonical = stableStringify(normalized);
    const existing = rowsByExternalId.get(posting.externalId);
    if (existing && existing.row.materialHash !== normalized.materialHash) {
      throw new Error(`Conflicting duplicate ingestion external ID: ${posting.externalId}`);
    }
    // Exact/materially equivalent duplicates can appear in more than one source
    // document. Pick their bytewise canonical representative so input ordering
    // can never change the retained snapshot body or hash.
    if (!existing || canonical < existing.canonical) {
      rowsByExternalId.set(posting.externalId, { row: normalized, canonical });
    }
  }
  const rows = [...rowsByExternalId.values()].map(({ row }) => row);
  rows.sort((left, right) => left.externalId.localeCompare(right.externalId));
  return {
    schemaVersion: INGESTION_V2_SNAPSHOT_SCHEMA_VERSION,
    sourceId: input.sourceId,
    snapshotHash: snapshotHashForRows(rows),
    admissionVersion: input.admissionVersion,
    documentCount: new Set(rows.map((row) => row.document)).size,
    rowCount: rows.length,
    observedAt: input.observedAt,
    rows,
  };
}

/** Hash the sorted `(externalId, materialHash)` pairs, never the volatile body. */
export function snapshotHashForRows(rows: readonly { externalId: string; materialHash: string }[]): string {
  const canonical = [...rows]
    .map((row) => ({ externalId: row.externalId, materialHash: row.materialHash }))
    .sort((left, right) => left.externalId.localeCompare(right.externalId));
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
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
  const envelope = parsed as NormalizedSnapshotEnvelope;
  if (envelope.schemaVersion !== INGESTION_V2_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Unsupported ingestion snapshot schema ${String(envelope.schemaVersion)}`);
  }
  if (envelope.sourceId !== expected.sourceId) throw new Error('Ingestion snapshot source mismatch');
  if (envelope.snapshotHash !== expected.snapshotHash) throw new Error('Ingestion snapshot key mismatch');
  if (!Array.isArray(envelope.rows)) throw new Error('Ingestion snapshot rows are missing');
  for (const row of envelope.rows) {
    if (!row || typeof row.externalId !== 'string' || !row.posting) throw new Error('Ingestion snapshot row is malformed');
    if (row.posting.externalId !== row.externalId) throw new Error('Ingestion snapshot row identity mismatch');
    if (materialHashFor(row.posting) !== row.materialHash) throw new Error('Ingestion snapshot row material mismatch');
  }
  const recomputed = snapshotHashForRows(envelope.rows);
  if (recomputed !== envelope.snapshotHash) throw new Error('Ingestion snapshot hash mismatch');
  return envelope;
}
