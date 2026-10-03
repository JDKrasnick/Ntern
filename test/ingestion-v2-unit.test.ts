import { describe, expect, it } from 'vitest';
import {
  materialHashFor,
  normalizeSourceSnapshot,
  parseEnvelope,
  serializeEnvelope,
  snapshotObjectKey,
  stableStringify,
} from '../src/ingestion-v2/normalize.js';
import { planSnapshotDiff } from '../src/ingestion-v2/diff.js';
import type { CompactIngestionRow, DiffPlannerInput } from '../src/ingestion-v2/types.js';
import type { SourcedPosting } from '../src/types.js';

const POSTING_FETCHED_AT = '2026-10-01T00:00:00.000Z';

function posting(overrides: Partial<SourcedPosting> & { externalId: string }): SourcedPosting {
  return {
    sourceId: 'community-example',
    provenance: 'reviewed-community',
    externalId: overrides.externalId,
    sourceUrl: 'https://github.com/example/jobs',
    document: overrides.document ?? 'README.md',
    row: overrides.row ?? 1,
    fetchedAt: overrides.fetchedAt ?? POSTING_FETCHED_AT,
    employer: overrides.employer ?? { id: 'example', name: 'Example', authority: 'reviewed-registry' },
    title: overrides.title ?? `Software Engineering Intern ${overrides.externalId}`,
    content: overrides.content ?? [{ kind: 'description', format: 'plain', value: 'Build production software.' }],
    locations: overrides.locations ?? ['Remote'],
    applyUrl: overrides.applyUrl ?? `https://jobs.example.com/${overrides.externalId}`,
    sourceState: overrides.sourceState ?? 'open',
    lifecycleAuthority: overrides.lifecycleAuthority ?? 'title',
    ...(overrides.seasonHint ? { seasonHint: overrides.seasonHint } : {}),
    ...(overrides.seasonHintAuthority ? { seasonHintAuthority: overrides.seasonHintAuthority } : {}),
    ...(overrides.publishedAt ? { publishedAt: overrides.publishedAt } : {}),
    ...(overrides.declaredWorkMode ? { declaredWorkMode: overrides.declaredWorkMode } : {}),
  };
}

function row(externalId: string, materialHash: string): { externalId: string; materialHash: string } {
  return { externalId, materialHash };
}

function ledgerRow(overrides: Partial<CompactIngestionRow> & { externalId: string; materialHash: string }): CompactIngestionRow {
  return {
    snapshotHash: 'a'.repeat(64),
    admissionVersion: 'standard-v1',
    state: 'settled',
    decision: 'admitted',
    attemptCount: 0,
    consecutiveOmissions: 0,
    ...overrides,
  };
}

function diffInput(overrides: Partial<DiffPlannerInput> & { rows: DiffPlannerInput['rows']; ledger: readonly CompactIngestionRow[] }): DiffPlannerInput {
  return {
    sourceId: 'community-example',
    snapshotHash: 'b'.repeat(64),
    admissionVersion: 'standard-v1',
    complete: true,
    now: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ingestion v2 normalization', () => {
  it('produces a deterministic snapshot hash independent of row and document ordering', () => {
    const rows = [posting({ externalId: 'a' }), posting({ externalId: 'b', document: 'SECOND.md' }), posting({ externalId: 'c' })];
    const forward = normalizeSourceSnapshot({ sourceId: 'community-example', postings: rows, admissionVersion: 'v1', observedAt: POSTING_FETCHED_AT });
    const reversed = normalizeSourceSnapshot({ sourceId: 'community-example', postings: [...rows].reverse(), admissionVersion: 'v1', observedAt: POSTING_FETCHED_AT });
    expect(forward.snapshotHash).toBe(reversed.snapshotHash);
    expect(forward.rowCount).toBe(3);
    expect(forward.documentCount).toBe(2);
    expect(forward.rows.map((entry) => entry.externalId)).toEqual(['a', 'b', 'c']);
  });

  it('omits volatile fetch metadata from the material hash', () => {
    const first = posting({ externalId: 'a', row: 1, fetchedAt: '2026-10-01T00:00:00.000Z' });
    const second = posting({ externalId: 'a', row: 42, fetchedAt: '2026-10-02T12:00:00.000Z' });
    expect(materialHashFor(first)).toBe(materialHashFor(second));
  });

  it('changes the material hash when source-owned content changes', () => {
    const first = posting({ externalId: 'a' });
    const second = posting({ externalId: 'a', title: 'Senior Software Engineering Intern' });
    expect(materialHashFor(first)).not.toBe(materialHashFor(second));
  });

  it('keeps the snapshot hash stable across a randomized input order with a recorded seed', () => {
    const seed = 0x5eed;
    const rng = mulberry32(seed);
    const rows = Array.from({ length: 64 }, (_, index) => posting({ externalId: `role-${index}` }));
    const baseline = normalizeSourceSnapshot({ sourceId: 'community-example', postings: rows, admissionVersion: 'v1', observedAt: POSTING_FETCHED_AT });
    for (let trial = 0; trial < 8; trial += 1) {
      const shuffled = shuffle([...rows], rng);
      const snapshot = normalizeSourceSnapshot({ sourceId: 'community-example', postings: shuffled, admissionVersion: 'v1', observedAt: POSTING_FETCHED_AT });
      expect(snapshot.snapshotHash, `seed=${seed} trial=${trial}`).toBe(baseline.snapshotHash);
    }
  });

  it('deduplicates rows that repeat an external id', () => {
    const duplicate = posting({ externalId: 'a' });
    const snapshot = normalizeSourceSnapshot({
      sourceId: 'community-example',
      postings: [duplicate, { ...duplicate, row: 99, fetchedAt: '2026-10-02T00:00:00.000Z' }],
      admissionVersion: 'v1',
      observedAt: POSTING_FETCHED_AT,
    });
    expect(snapshot.rowCount).toBe(1);
  });

  it('rejects conflicting duplicate external ids independent of input ordering', () => {
    const first = posting({ externalId: 'a', title: 'Software Engineering Intern' });
    const second = posting({ externalId: 'a', title: 'Data Engineering Intern' });
    const normalize = (postings: SourcedPosting[]) => normalizeSourceSnapshot({
      sourceId: 'community-example', postings, admissionVersion: 'v1', observedAt: POSTING_FETCHED_AT,
    });
    expect(() => normalize([first, second])).toThrow(/Conflicting duplicate ingestion external ID: a/u);
    expect(() => normalize([second, first])).toThrow(/Conflicting duplicate ingestion external ID: a/u);
  });

  it('validates the content-addressed key', () => {
    expect(snapshotObjectKey('community-example', 'a'.repeat(64))).toBe(`ingestion-v2/snapshots/community-example/${'a'.repeat(64)}.json`);
    expect(() => snapshotObjectKey('../escape', 'a'.repeat(64))).toThrow(/Invalid ingestion source id/);
    expect(() => snapshotObjectKey('community-example', 'not-a-hash')).toThrow(/Invalid ingestion snapshot hash/);
  });

  it('rejects a snapshot whose hash no longer matches its body', () => {
    const envelope = normalizeSourceSnapshot({ sourceId: 'community-example', postings: [posting({ externalId: 'a' })], admissionVersion: 'v1', observedAt: POSTING_FETCHED_AT });
    const raw = serializeEnvelope(envelope);
    expect(parseEnvelope(raw, { sourceId: 'community-example', snapshotHash: envelope.snapshotHash }).rowCount).toBe(1);

    const tampered = JSON.parse(raw) as typeof envelope;
    tampered.rows[0]!.posting.title = 'Tampered';
    expect(() => parseEnvelope(JSON.stringify(tampered), { sourceId: 'community-example', snapshotHash: envelope.snapshotHash }))
      .toThrow(/mismatch/u);

    expect(() => parseEnvelope(raw, { sourceId: 'community-example', snapshotHash: 'f'.repeat(64) }))
      .toThrow(/key mismatch/u);
  });

  it('rejects admission-relevant envelope metadata that is not self-consistent', () => {
    const envelope = normalizeSourceSnapshot({
      sourceId: 'community-example',
      postings: [posting({ externalId: 'a', sourceState: 'closed' })],
      admissionVersion: 'v1',
      observedAt: POSTING_FETCHED_AT,
    });
    const parse = (mutate: (candidate: typeof envelope) => void) => {
      const candidate = structuredClone(envelope);
      mutate(candidate);
      return () => parseEnvelope(serializeEnvelope(candidate), {
        sourceId: envelope.sourceId,
        snapshotHash: envelope.snapshotHash,
      });
    };

    expect(parse((candidate) => { candidate.rowCount = 2; })).toThrow(/row count mismatch/u);
    expect(parse((candidate) => { candidate.documentCount = 2; })).toThrow(/document count mismatch/u);
    expect(parse((candidate) => { candidate.rows[0]!.posting.sourceId = 'other-source'; })).toThrow(/posting source mismatch/u);
    expect(parse((candidate) => { candidate.rows[0]!.firstObservationEligible = true; })).toThrow(/eligibility mismatch/u);
    expect(parse((candidate) => { candidate.rows[0]!.document = 'OTHER.md'; })).toThrow(/provenance mismatch/u);
    expect(parse((candidate) => { candidate.rows[0]!.row = 99; })).toThrow(/provenance mismatch/u);
  });

  it('rejects duplicate or noncanonical snapshot row ordering', () => {
    const envelope = normalizeSourceSnapshot({
      sourceId: 'community-example',
      postings: [posting({ externalId: 'a' }), posting({ externalId: 'b' })],
      admissionVersion: 'v1',
      observedAt: POSTING_FETCHED_AT,
    });
    const reversed = structuredClone(envelope);
    reversed.rows.reverse();
    expect(() => parseEnvelope(serializeEnvelope(reversed), {
      sourceId: envelope.sourceId,
      snapshotHash: envelope.snapshotHash,
    })).toThrow(/canonically ordered/u);

    const duplicate = structuredClone(envelope);
    duplicate.rows[1] = structuredClone(duplicate.rows[0]!);
    expect(() => parseEnvelope(serializeEnvelope(duplicate), {
      sourceId: envelope.sourceId,
      snapshotHash: envelope.snapshotHash,
    })).toThrow(/not unique/u);
  });

  it('stable-stringifies object keys deterministically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
});

describe('ingestion v2 diff planner', () => {
  it('classifies new, unchanged, and missing rows', () => {
    const diff = planSnapshotDiff(diffInput({
      rows: [row('known', 'm-known'), row('fresh', 'm-fresh')],
      ledger: [ledgerRow({ externalId: 'known', materialHash: 'm-known' }), ledgerRow({ externalId: 'gone', materialHash: 'm-gone' })],
    }));
    expect(diff.counts).toMatchObject({ total: 2, new: 1, unchanged: 1, missing: 1 });
    expect(diff.actionableExternalIds).toEqual(['fresh']);
    expect(diff.omissionUpdates).toEqual([{ externalId: 'gone', consecutiveOmissions: 1, becomesAbsent: false }]);
  });

  it('detects a changed row below known rows and in a later document', () => {
    const diff = planSnapshotDiff(diffInput({
      rows: [
        row('known-1', 'm-1'),
        row('known-2', 'm-2'),
        row('changed', 'm-changed-new'),
        row('late', 'm-late'),
      ],
      ledger: [
        ledgerRow({ externalId: 'known-1', materialHash: 'm-1' }),
        ledgerRow({ externalId: 'known-2', materialHash: 'm-2' }),
        ledgerRow({ externalId: 'changed', materialHash: 'm-changed-old' }),
        ledgerRow({ externalId: 'late', materialHash: 'm-late' }),
      ],
    }));
    expect(diff.counts.changed).toBe(1);
    expect(diff.actionableExternalIds).toEqual(['changed']);
    expect(diff.counts.missing).toBe(0);
  });

  it('returns zero actionable rows for a repeated identical snapshot', () => {
    const rows = [row('a', 'm-a'), row('b', 'm-b')];
    const ledger = rows.map((entry) => ledgerRow({ externalId: entry.externalId, materialHash: entry.materialHash }));
    const diff = planSnapshotDiff(diffInput({ rows, ledger }));
    expect(diff.counts).toMatchObject({ total: 2, unchanged: 2, new: 0, changed: 0, missing: 0 });
    expect(diff.actionableExternalIds).toEqual([]);
  });

  it('selects only settled rows under a stale admission version', () => {
    const diff = planSnapshotDiff(diffInput({
      admissionVersion: 'v2',
      rows: [row('stale', 'm'), row('current', 'm'), row('pending-new', 'm-new')],
      ledger: [
        ledgerRow({ externalId: 'stale', materialHash: 'm', admissionVersion: 'v1' }),
        ledgerRow({ externalId: 'current', materialHash: 'm', admissionVersion: 'v2' }),
        ledgerRow({ externalId: 'pending-new', materialHash: 'm-old', admissionVersion: 'v2', state: 'pending', decision: undefined }),
      ],
    }));
    expect(diff.counts.stalePolicy).toBe(1);
    expect(diff.actionableExternalIds).toContain('stale');
    expect(diff.rows.find((entry) => entry.externalId === 'current')?.classification).toBe('unchanged');
  });

  it('honors retry scheduling boundaries', () => {
    const rows = [row('due', 'm'), row('future', 'm'), row('past', 'm')];
    const ledger = [
      ledgerRow({ externalId: 'due', materialHash: 'm', state: 'pending', decision: undefined, retryAt: '2026-10-01T00:00:00.000Z' }),
      ledgerRow({ externalId: 'future', materialHash: 'm', state: 'pending', decision: undefined, retryAt: '2026-10-01T01:00:00.000Z' }),
      ledgerRow({ externalId: 'past', materialHash: 'm', state: 'quarantined', decision: 'blocked', retryAt: '2026-09-30T00:00:00.000Z' }),
    ];
    const diff = planSnapshotDiff(diffInput({ now: '2026-10-01T00:00:00.000Z', rows, ledger }));
    expect(diff.rows.find((entry) => entry.externalId === 'due')?.classification).toBe('retryable');
    expect(diff.rows.find((entry) => entry.externalId === 'past')?.classification).toBe('retryable');
    expect(diff.rows.find((entry) => entry.externalId === 'future')?.classification).toBe('unchanged');
    expect(diff.actionableExternalIds).toEqual(['due', 'past']);
  });

  it('classifies a previously absent row that returns as reappeared', () => {
    const diff = planSnapshotDiff(diffInput({
      rows: [row('returned', 'm-new')],
      ledger: [ledgerRow({ externalId: 'returned', materialHash: 'm-old', state: 'absent', decision: 'blocked', consecutiveOmissions: 2 })],
    }));
    expect(diff.rows[0]?.classification).toBe('reappeared');
    expect(diff.actionableExternalIds).toEqual(['returned']);
    expect(diff.counts.missing).toBe(0);
  });

  it('becomes absent only after two complete missing snapshots', () => {
    const first = planSnapshotDiff(diffInput({ rows: [], ledger: [ledgerRow({ externalId: 'gone', materialHash: 'm' })] }));
    expect(first.omissionUpdates).toEqual([{ externalId: 'gone', consecutiveOmissions: 1, becomesAbsent: false }]);
    const second = planSnapshotDiff(diffInput({
      rows: [],
      ledger: [ledgerRow({ externalId: 'gone', materialHash: 'm', consecutiveOmissions: 1 })],
    }));
    expect(second.omissionUpdates).toEqual([{ externalId: 'gone', consecutiveOmissions: 2, becomesAbsent: true }]);
    // An already-absent row is not re-counted.
    const third = planSnapshotDiff(diffInput({
      rows: [],
      ledger: [ledgerRow({ externalId: 'gone', materialHash: 'm', state: 'absent', consecutiveOmissions: 2 })],
    }));
    expect(third.omissionUpdates).toEqual([]);
  });

  it('preserves omission counts for an incomplete snapshot', () => {
    const diff = planSnapshotDiff(diffInput({
      complete: false,
      rows: [row('fresh', 'm')],
      ledger: [ledgerRow({ externalId: 'gone', materialHash: 'm' })],
    }));
    expect(diff.complete).toBe(false);
    expect(diff.actionableExternalIds).toEqual([]);
    expect(diff.omissionUpdates).toEqual([]);
    expect(diff.counts.missing).toBe(0);
  });

  it('is independent of row ordering', () => {
    const rows = [row('b', 'm-b'), row('a', 'm-a'), row('c', 'm-c')];
    const ledger = [ledgerRow({ externalId: 'c', materialHash: 'm-old' })];
    const forward = planSnapshotDiff(diffInput({ rows, ledger }));
    const reversed = planSnapshotDiff(diffInput({ rows: [...rows].reverse(), ledger }));
    expect(reversed).toEqual(forward);
  });
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [items[index], items[swap]] = [items[swap]!, items[index]!];
  }
  return items;
}
