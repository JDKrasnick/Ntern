import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defaultSources, GitHubMarkdownAdapter } from '../src/sources/github.js';
import { parseQuantInternshipMarkdown } from '../src/sources/quant.js';
import {
  materialHashFor,
  normalizeSourceSnapshot,
  parseEnvelope,
  serializeEnvelope,
  stableStringify,
} from '../src/ingestion-v2/normalize.js';
import { planSnapshotDiff } from '../src/ingestion-v2/diff.js';
import type { CompactIngestionRow, NormalizedSnapshotEnvelope } from '../src/ingestion-v2/types.js';
import type { MarkdownParseOptions } from '../src/core/markdown.js';
import type { RawListing, SourcedPosting } from '../src/types.js';

interface Revision { sha: string; observedAt: string }
interface HistoricalSource {
  id: string;
  owner: string;
  repo: string;
  documents: Array<{ path: string; branch: string; season: string }>;
  revisions: Revision[];
  parser?: (markdown: string, options: MarkdownParseOptions) => RawListing[];
}

const admissionVersion = 'historical-parity-v1';
const byExternalId = (left: string, right: string): number => left.localeCompare(right);
const expected = {
  sources: 6,
  snapshots: 18,
  transitions: 12,
  bytes: 11_407_955,
  rows: 17_997,
  reportDigest: 'a39d3235420847ffd3dcb57988ede237d9d3ad002041b5ce2f4385db7c10adf5',
};
const sources: HistoricalSource[] = [
  {
    id: 'vanshb03-summer-2027', owner: 'vanshb03', repo: 'Summer2027-Internships',
    documents: [
      { path: 'README.md', branch: 'dev', season: 'summer-2027' },
      { path: 'OFFSEASON_README.md', branch: 'dev', season: 'offseason-2027' },
    ],
    revisions: [
      { sha: '59f8013625227c442be99cf7bf895162d79e1c6b', observedAt: '2026-07-31T20:31:28Z' },
      { sha: '5eb0c88555c8568cad82ed7a64126793fe9a1a50', observedAt: '2026-08-04T14:24:13Z' },
      { sha: '4bd5d6d378b5a447f2766e254d85f8f4f304bf8f', observedAt: '2026-08-21T15:52:57Z' },
    ],
  },
  {
    id: 'simplify-summer-2026', owner: 'SimplifyJobs', repo: 'Summer2027-Internships',
    documents: [
      { path: 'README.md', branch: 'dev', season: 'summer-2027' },
      { path: 'README-Off-Season.md', branch: 'dev', season: 'offseason-2027' },
    ],
    revisions: [
      { sha: 'f2da33db567d109019547f88190cc73c307326d4', observedAt: '2026-10-01T15:01:56Z' },
      { sha: 'a124c2f2061600548d7107cad83a26a5ca61e0ad', observedAt: '2026-10-02T18:31:44Z' },
      { sha: 'bb6a933bdd86533d7a28d5405e592ffe2a735234', observedAt: '2026-10-04T06:31:41Z' },
    ],
  },
  {
    id: 'speedyapply-2027-swe', owner: 'speedyapply', repo: '2027-SWE-College-Jobs',
    documents: [
      { path: 'README.md', branch: 'main', season: 'summer-2027' },
      { path: 'INTERN_INTL.md', branch: 'main', season: 'summer-2027' },
    ],
    revisions: [
      { sha: '8907df8fbd7802b89f36d407f66bc25269aee41b', observedAt: '2026-09-14T17:58:24Z' },
      { sha: '3045ff8b3e03e4db5bef486321f99ad8f216d532', observedAt: '2026-09-23T16:36:16Z' },
      { sha: '5184c5f76c097f7e8767f89e45c932ac2af4a1f5', observedAt: '2026-10-03T16:02:39Z' },
    ],
  },
  {
    id: 'speedyapply-2027-ai', owner: 'speedyapply', repo: '2027-AI-College-Jobs',
    documents: [
      { path: 'README.md', branch: 'main', season: 'summer-2027' },
      { path: 'INTERN_INTL.md', branch: 'main', season: 'summer-2027' },
    ],
    revisions: [
      { sha: 'f8ea0c89365dc6fa2a7b800b841867ac733b47fb', observedAt: '2026-09-14T17:57:39Z' },
      { sha: '4ea69d1e8a4c2118e1010c4cd162596e25e8ee0a', observedAt: '2026-09-23T16:34:15Z' },
      { sha: 'dff809e2b1d88015fcaba0789eb4b888d21e3e68', observedAt: '2026-10-03T16:01:39Z' },
    ],
  },
  {
    id: 'northwestern-fintech-2027-quant', owner: 'northwesternfintech', repo: '2027QuantInternships',
    documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
    parser: parseQuantInternshipMarkdown,
    revisions: [
      { sha: '99ac3ff3584a53eaade962c8ca5e9e0fb8b1c23f', observedAt: '2025-09-08T21:31:16Z' },
      { sha: 'd17d5316cc58e48895dd73e6b031e890be7d0aa8', observedAt: '2026-06-05T19:36:33Z' },
      { sha: 'e61d1999bbfba5afaea4c535e179cd04b61feb8e', observedAt: '2026-07-30T04:52:18Z' },
    ],
  },
  {
    id: 'canadian-tech-2027', owner: 'negarprh', repo: 'Canadian-Tech-Internships-2027',
    documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
    revisions: [
      { sha: '70623e55ac2853e5b595faf69722bb60b4a98476', observedAt: '2026-09-01T12:24:49Z' },
      { sha: '723bd5512e1fc428b51c62f9e122f445d98c7074', observedAt: '2026-09-17T12:26:12Z' },
      { sha: '3ebc697f11597351262697b6707c8924017e15b3', observedAt: '2026-10-03T15:43:22Z' },
    ],
  },
];
assert.deepEqual(
  sources.map((source) => source.id).sort(byExternalId),
  defaultSources.map((source) => source.id).sort(byExternalId),
  'historical coverage must match the configured GitHub sources',
);

function pinnedFetch(revision: Revision, bytes: { value: number }): typeof fetch {
  return async (input, init) => {
    const requested = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const parts = requested.pathname.split('/');
    assert.equal(requested.hostname, 'raw.githubusercontent.com');
    assert.ok(parts.length >= 5, requested.pathname);
    parts[3] = revision.sha;
    requested.pathname = parts.join('/');
    const response = await fetch(requested, init);
    if (!response.ok) return response;
    const body = await response.arrayBuffer();
    bytes.value += body.byteLength;
    return new Response(body, { status: response.status, headers: response.headers });
  };
}

function postingById(postings: readonly SourcedPosting[]): Map<string, SourcedPosting> {
  const result = new Map<string, SourcedPosting>();
  for (const posting of postings) {
    const prior = result.get(posting.externalId);
    if (prior) assert.equal(materialHashFor(prior), materialHashFor(posting), `conflicting duplicate ${posting.externalId}`);
    else result.set(posting.externalId, posting);
  }
  return result;
}

function ledgerFor(envelope: NormalizedSnapshotEnvelope): CompactIngestionRow[] {
  return envelope.rows.map((row) => ({
    externalId: row.externalId,
    snapshotHash: envelope.snapshotHash,
    materialHash: row.materialHash,
    admissionVersion: envelope.admissionVersion,
    state: 'settled',
    attemptCount: 1,
    consecutiveOmissions: 0,
    lastObservedAt: envelope.observedAt,
  }));
}

const report: Array<Record<string, unknown>> = [];
for (const source of sources) {
  const envelopes: NormalizedSnapshotEnvelope[] = [];
  for (const revision of source.revisions) {
    const bytes = { value: 0 };
    const adapter = new GitHubMarkdownAdapter({
      id: source.id, owner: source.owner, repo: source.repo, documents: source.documents,
      ...(source.parser ? { parser: source.parser } : {}), fetchImpl: pinnedFetch(revision, bytes),
    });
    const fetched = await adapter.fetch();
    assert.ok(fetched && 'postings' in fetched, `${source.id}@${revision.sha} did not produce a complete snapshot`);
    const unique = postingById(fetched.postings);
    const envelope = normalizeSourceSnapshot({
      sourceId: source.id, postings: fetched.postings, admissionVersion, observedAt: revision.observedAt,
    });
    assert.equal(envelope.rowCount, unique.size);
    assert.deepEqual(envelope.rows.map((row) => row.externalId), [...unique.keys()].sort(byExternalId));
    for (const row of envelope.rows) assert.equal(row.materialHash, materialHashFor(unique.get(row.externalId)!));
    const parsed = parseEnvelope(serializeEnvelope(envelope), { sourceId: source.id, snapshotHash: envelope.snapshotHash });
    assert.equal(serializeEnvelope(parsed), serializeEnvelope(envelope));
    const reordered = normalizeSourceSnapshot({
      sourceId: source.id, postings: [...fetched.postings].reverse(), admissionVersion,
      observedAt: new Date(Date.parse(revision.observedAt) + 60_000).toISOString(),
    });
    assert.equal(reordered.snapshotHash, envelope.snapshotHash, 'source ordering changed the V2 identity');
    assert.deepEqual(reordered.rows.map((row) => [row.externalId, row.materialHash]), envelope.rows.map((row) => [row.externalId, row.materialHash]));
    envelopes.push(envelope);
    report.push({
      sourceId: source.id, sha: revision.sha, observedAt: revision.observedAt, bytes: bytes.value,
      rawRows: fetched.rawRowCount, eligibleRows: fetched.postings.length, uniqueRows: unique.size,
      documents: envelope.documentCount, snapshotHash: envelope.snapshotHash,
      semanticDigest: createHash('sha256').update(stableStringify(envelope.rows.map((row) => ({
        externalId: row.externalId, materialHash: row.materialHash,
      })))).digest('hex'),
    });
  }

  for (let index = 1; index < envelopes.length; index += 1) {
    const previous = envelopes[index - 1]!;
    const current = envelopes[index]!;
    const before = new Map(previous.rows.map((row) => [row.externalId, row.materialHash]));
    const after = new Map(current.rows.map((row) => [row.externalId, row.materialHash]));
    const expectedNew = [...after].filter(([id]) => !before.has(id)).map(([id]) => id).sort(byExternalId);
    const expectedChanged = [...after].filter(([id, hash]) => before.has(id) && before.get(id) !== hash).map(([id]) => id).sort(byExternalId);
    const expectedMissing = [...before].filter(([id]) => !after.has(id)).map(([id]) => id).sort(byExternalId);
    const diff = planSnapshotDiff({
      sourceId: source.id, snapshotHash: current.snapshotHash, admissionVersion,
      rows: current.rows, ledger: ledgerFor(previous), complete: true, now: current.observedAt,
    });
    assert.deepEqual(diff.rows.filter((row) => row.classification === 'new').map((row) => row.externalId), expectedNew);
    assert.deepEqual(diff.rows.filter((row) => row.classification === 'changed').map((row) => row.externalId), expectedChanged);
    assert.deepEqual(diff.omissionUpdates.map((row) => row.externalId), expectedMissing);
    const secondOmission = planSnapshotDiff({
      sourceId: source.id, snapshotHash: current.snapshotHash, admissionVersion,
      rows: current.rows,
      ledger: ledgerFor(previous).map((row) => expectedMissing.includes(row.externalId) ? { ...row, consecutiveOmissions: 1 } : row),
      complete: true, now: current.observedAt,
    });
    assert.deepEqual(secondOmission.omissionUpdates.filter((row) => row.becomesAbsent).map((row) => row.externalId), expectedMissing);
    report.push({
      sourceId: source.id, transition: `${previous.observedAt}->${current.observedAt}`,
      new: expectedNew.length, changed: expectedChanged.length, missing: expectedMissing.length,
      unchanged: diff.counts.unchanged,
    });
  }
}

const snapshots = report.filter((row) => 'sha' in row);
const transitions = report.filter((row) => 'transition' in row);
const summary = {
  sources: sources.length,
  snapshots: snapshots.length,
  transitions: transitions.length,
  bytes: snapshots.reduce((total, row) => total + Number(row.bytes), 0),
  rows: snapshots.reduce((total, row) => total + Number(row.uniqueRows), 0),
  reportDigest: createHash('sha256').update(stableStringify(report)).digest('hex'),
};
assert.deepEqual(summary, expected, 'historical ingestion report changed');
console.log(JSON.stringify({
  ...summary,
  report,
}, null, 2));
