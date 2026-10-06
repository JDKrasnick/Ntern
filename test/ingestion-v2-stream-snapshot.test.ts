import { describe, expect, it } from 'vitest';
import { normalizeSourceSnapshot, serializeEnvelope, snapshotHashForRows } from '../src/ingestion-v2/normalize.js';
import { readSnapshotRows, SNAPSHOT_STREAM_MAX_ROW_BYTES } from '../src/ingestion-v2/stream-snapshot.js';
import type { SourcedPosting } from '../src/types.js';
import { R2IngestionSnapshotStore } from '../cloudflare/ingestion-v2-store.js';
import type { R2Bucket } from '../cloudflare/types.js';

function fixture() {
  const postings: SourcedPosting[] = ['a', 'b', 'c'].map((externalId) => ({
    sourceId: 'example', externalId, provenance: 'reviewed-community', sourceUrl: 'https://github.com/example/jobs',
    document: 'README.md', row: 1, fetchedAt: '2026-10-01T00:00:00.000Z',
    employer: { id: 'example', name: 'Example', authority: 'reviewed-registry' },
    title: `Intern ${externalId} Montréal 🦘`, content: [{ kind: 'description', format: 'plain', value: 'A "quote", a \\ slash and café.' }],
    locations: ['Remote'], applyUrl: `https://jobs.example.com/${externalId}`, sourceState: 'open', lifecycleAuthority: 'title',
  }));
  return normalizeSourceSnapshot({ sourceId: 'example', postings, admissionVersion: 'v1', observedAt: '2026-10-01T00:00:00.000Z' });
}

function stream(raw: string, chunkSize = 8192, canceled = () => {}) {
  const bytes = new TextEncoder().encode(raw);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunkSize)); offset = Math.min(bytes.length, offset + chunkSize);
    }, cancel: canceled,
  });
}

describe('bounded immutable snapshot reader', () => {
  it.each([1, 7, 8192, 100_000])('validates UTF-8 and escaped content across %i-byte chunks, retaining only requested rows', async (size) => {
    const envelope = fixture();
    const result = await readSnapshotRows(stream(serializeEnvelope(envelope), size), envelope, ['b', 'missing']);
    expect([...result.rows.keys()]).toEqual(['b']);
    expect(result.rows.get('b')).toEqual(envelope.rows[1]);
    expect(result.bytes).toBe(new TextEncoder().encode(serializeEnvelope(envelope)).length);
  });
  it('accepts legacy hashes and rows before headers', async () => {
    const envelope = fixture();
    const { rows, ...header } = envelope;
    const legacy = { rows, ...header, schemaVersion: 1, snapshotHash: snapshotHashForRows(rows) };
    expect((await readSnapshotRows(stream(JSON.stringify(legacy)), legacy, [])).rows.size).toBe(0);
  });
  it.each(['unselected-content', 'row-count', 'document-count', 'source', 'policy', 'row-order', 'duplicate-row', 'truncated', 'trailing', 'duplicate-header', 'array-row', 'object-header'])('fails closed on %s', async (fault) => {
    const expected = fixture();
    const envelope = structuredClone(expected);
    if (fault === 'unselected-content') envelope.rows[2]!.posting.title = 'Tampered';
    if (fault === 'row-count') envelope.rowCount += 1;
    if (fault === 'document-count') envelope.documentCount += 1;
    if (fault === 'source') envelope.sourceId = 'other';
    if (fault === 'policy') envelope.admissionVersion = 'other';
    if (fault === 'row-order') envelope.rows.reverse();
    if (fault === 'duplicate-row') envelope.rows[2] = envelope.rows[1]!;
    let raw = serializeEnvelope(envelope);
    if (fault === 'truncated') raw = raw.slice(0, -2);
    if (fault === 'trailing') raw += '{}';
    if (fault === 'duplicate-header') raw = raw.replace('{', '{"sourceId":"example",');
    if (fault === 'array-row') raw = raw.replace('"rows":[', '"rows":[[],');
    if (fault === 'object-header') raw = raw.replace('"admissionVersion":"v1"', '"admissionVersion":{}');
    let canceled = false;
    await expect(readSnapshotRows(stream(raw, 7, () => { canceled = true; }), expected, ['a'])).rejects.toThrow();
    // Cancellation is best-effort if the source has already reached EOF.
    if (fault === 'array-row' || fault === 'object-header') expect(canceled).toBe(true);
  });
  it('cancels an oversized unfinished row before buffering its full body', async () => {
    const expected = fixture();
    let canceled = false;
    const raw = '{"rows":[{"externalId":"' + 'x'.repeat(SNAPSHOT_STREAM_MAX_ROW_BYTES * 2);
    await expect(readSnapshotRows(stream(raw, 4096, () => { canceled = true; }), expected, [])).rejects.toThrow('row exceeds byte limit');
    expect(canceled).toBe(true);
  });
  it('rejects batches above the queue limit', async () => {
    const envelope = fixture();
    await expect(readSnapshotRows(stream(serializeEnvelope(envelope)), envelope, Array(26).fill('a'))).rejects.toThrow('batch limit');
  });
  it('preserves immutable R2 bytes, reports UTF-8 size consistently, and refuses corrupted reuse', async () => {
    const envelope = fixture();
    let stored: Uint8Array | undefined;
    let writes = 0;
    const bucket = {
      async put(_key: string, body: ArrayBuffer) { stored = new Uint8Array(body); writes += 1; },
      async get() { return stored ? { body: stream(new TextDecoder().decode(stored), 7) } : null; },
      async delete() {},
    } as unknown as R2Bucket;
    const store = new R2IngestionSnapshotStore(bucket);
    const first = await store.putSnapshot(envelope);
    const original = stored!.slice();
    const repeat = await store.putSnapshot({ ...envelope, observedAt: '2026-10-02T00:00:00.000Z' });
    expect(first.bytes).toBe(original.byteLength);
    expect(repeat).toEqual({ ...first, existed: true });
    expect(stored).toEqual(original);
    expect(writes).toBe(1);
    expect([...(await store.getSnapshotRows(envelope.sourceId, envelope.snapshotHash, ['b'])).keys()]).toEqual(['b']);
    const corrupted = structuredClone(envelope);
    corrupted.rows[2]!.posting.title = 'Corrupt unselected row';
    stored = new TextEncoder().encode(serializeEnvelope(corrupted));
    await expect(store.getSnapshotRows(envelope.sourceId, envelope.snapshotHash, ['a'])).rejects.toThrow('material mismatch');
    await expect(store.putSnapshot(envelope)).rejects.toThrow('material mismatch');
    expect(writes).toBe(1);
  });
});
