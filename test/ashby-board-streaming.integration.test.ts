import { describe, expect, it } from 'vitest';
import { createMetadataAcquirer } from '../src/metadata-acquisition.js';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';
import type { ProviderIdentity } from '../src/types.js';

/**
 * Integration-level stress of the streamed Ashby board scanner. Unlike the unit
 * tests in metadata-acquisition.test.ts, every case here drives a single
 * batch-scoped acquirer the way the destination-verification consumer does, and
 * the live block reads real multi-megabyte boards over the network.
 */

const uuidFor = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const identity = (postingId: string, tenant = 'acme'): ProviderIdentity =>
  ({ provider: 'ashby', postingId, tenant, sourceId: `ashby-${tenant}`, sourceUrl: `https://api.ashbyhq.com/posting-api/job-board/${tenant}?includeCompensation=true` });

function boardBytes(rows: Array<Record<string, unknown>>, tenant = 'acme'): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    jobs: rows.map((row) => ({ jobUrl: `https://jobs.ashbyhq.com/${tenant}/${row.id}`, ...row })),
  }));
}

function streamed(bytes: Uint8Array, chunkSize: number): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize));
      controller.close();
    },
  }), { headers: { 'content-type': 'application/json' } });
}

const live = process.env.ASHBY_LIVE === '1';

describe('Ashby board streaming integration', () => {
  it('acquires every posting one board publishes through a single batch-scoped acquirer', async () => {
    const ids = [uuidFor(1), uuidFor(2), uuidFor(3), uuidFor(4), uuidFor(5)];
    const bytes = boardBytes(ids.map((id, index) => ({ id, title: `Role ${index}`, descriptionPlain: `Body ${index} ` + 'x'.repeat(30_000) })));
    // Destination verification runs one acquirer per batch (up to 5 messages), so
    // the same board is fetched once and then asked for each posting.
    let fetches = 0;
    const acquire = createMetadataAcquirer(async () => { fetches += 1; return streamed(bytes, 4_096); });
    for (const [index, id] of ids.entries()) {
      const result = await acquire(identity(id));
      expect(result?.outcome, `posting ${index}`).toBe('acquired');
      expect(result?.artifact?.text, `posting ${index}`).toContain(`Body ${index} `);
    }
    // Refetching per posting is what triggers provider throttling, so the board
    // must be read once for the whole batch.
    expect(fetches).toBe(1);
  });

  it('serves postings requested out of board order from the one fetched board', async () => {
    const ids = [uuidFor(1), uuidFor(2), uuidFor(3), uuidFor(4), uuidFor(5)];
    const bytes = boardBytes(ids.map((id, index) => ({ id, title: `Role ${index}`, descriptionPlain: `Body ${index} ` + 'x'.repeat(30_000) })));
    let fetches = 0;
    const acquire = createMetadataAcquirer(async () => { fetches += 1; return streamed(bytes, 4_096); });
    for (const index of [4, 0, 3, 1, 2]) {
      const result = await acquire(identity(ids[index]!));
      expect(result?.outcome, `posting ${index}`).toBe('acquired');
      expect(result?.artifact?.text, `posting ${index}`).toContain(`Body ${index} `);
    }
    expect(fetches).toBe(1);
  });

  it('serves concurrent postings from one board without refetching', async () => {
    const ids = [uuidFor(1), uuidFor(2), uuidFor(3), uuidFor(4), uuidFor(5)];
    const bytes = boardBytes(ids.map((id, index) => ({ id, title: `Role ${index}`, descriptionPlain: `Body ${index} ` + 'x'.repeat(30_000) })));
    let fetches = 0;
    const acquire = createMetadataAcquirer(async () => { fetches += 1; return streamed(bytes, 4_096); });
    const results = await Promise.all(ids.map((id) => acquire(identity(id))));
    expect(results.map((result) => result?.outcome)).toEqual(Array(ids.length).fill('acquired'));
    expect(fetches).toBe(1);
  });

  it('stops reading once the matching posting is found on a board past the acquisition ceiling', async () => {
    const filler = 'x'.repeat(20_000);
    const rows = Array.from({ length: 150 }, (_, index) => ({ id: uuidFor(100 + index), title: `Role ${index}`, descriptionPlain: filler }));
    const bytes = boardBytes([{ id: uuidFor(1), title: 'Target Intern', descriptionPlain: 'Build streaming acquisition.' }, ...rows]);
    expect(bytes.byteLength).toBeGreaterThan(2_000_000);

    const result = await createMetadataAcquirer(async () => streamed(bytes, 8_192))(identity(uuidFor(1)));
    expect(result?.outcome).toBe('acquired');
    expect(result?.artifact?.text).toContain('Build streaming acquisition.');
    // The target is the first element, so the scanner must not have read the board.
    expect(result?.bytes ?? Number.MAX_SAFE_INTEGER).toBeLessThan(bytes.byteLength / 4);
  });

  it('keeps the matching posting across adversarial chunk sizes, escapes and multibyte text', async () => {
    const bytes = boardBytes([
      { id: uuidFor(1), title: 'Other', descriptionPlain: 'y'.repeat(4_000) },
      { id: uuidFor(2), title: 'Target "Intern" \\ Role', descriptionHtml: `<div>{"a":[1,2,3]}</div>Quote "hi" \\ 🚀 café 日本語</div>` },
    ]);
    for (const chunkSize of [1, 2, 3, 5, 7, 17, 128, 4_093]) {
      const result = await createMetadataAcquirer(async () => streamed(bytes, chunkSize))(identity(uuidFor(2)));
      expect(result?.outcome, `chunk ${chunkSize}`).toBe('acquired');
      expect(result?.artifact?.text, `chunk ${chunkSize}`).toContain('café');
    }
  });

  it('ignores stray top-level arrays and nested arrays instead of matching the wrong posting', async () => {
    const stray = new TextEncoder().encode(JSON.stringify({
      departments: [{ id: uuidFor(1), title: 'Fake', jobUrl: `https://evil.example/acme/${uuidFor(1)}`, descriptionPlain: 'nope' }],
      meta: { list: [{ id: uuidFor(1), title: 'Nested', jobUrl: `https://jobs.ashbyhq.com/acme/${uuidFor(1)}`, descriptionPlain: 'nested' }] },
      jobs: [{ id: uuidFor(2), title: 'Real', jobUrl: `https://jobs.ashbyhq.com/acme/${uuidFor(2)}`, descriptionPlain: 'real body' }],
    }));
    const result = await createMetadataAcquirer(async () => streamed(stray, 24))(identity(uuidFor(1)));
    expect(result?.artifact).toBeUndefined();
    expect(result?.outcome).toBe('identity-mismatch');
  });

  it('treats a malformed board as a miss, never as a wrong artifact', async () => {
    const truncated = new TextEncoder().encode('{"jobs":[{"id":"' + uuidFor(1) + '","title":"Cut');
    const result = await createMetadataAcquirer(async () => streamed(truncated, 16))(identity(uuidFor(1)));
    expect(result?.artifact).toBeUndefined();
    expect(result?.outcome).toBe('identity-mismatch');
  });

  it('reports a miss when the requested posting is absent without reading the whole board into an artifact', async () => {
    const bytes = boardBytes(Array.from({ length: 30 }, (_, index) => ({ id: uuidFor(200 + index), title: `Role ${index}`, descriptionPlain: 'z'.repeat(1_000) })));
    const result = await createMetadataAcquirer(async () => streamed(bytes, 256))(identity(uuidFor(999)));
    expect(result?.outcome).toBe('identity-mismatch');
    expect(result?.artifact).toBeUndefined();
  });

  // Opt-in read-only contract against the real provider. `ASHBY_LIVE=1`.
  describe.skipIf(!live)('live Ashby boards', () => {
    const large = reviewedAshbySources.filter((source) => ['ashby-mistral-ai', 'ashby-notion', 'ashby-sentry'].includes(source.id));
    it.each(large.map((source) => [source.id, source] as const))('%s streams a real board and yields one posting', async (id, source) => {
      const tenant = source.identity.boardKey;
      const url = `https://api.ashbyhq.com/posting-api/job-board/${tenant}?includeCompensation=true`;
      const board = await fetch(url, { headers: { Accept: 'application/json' } });
      expect(board.status, `${id} status`).toBe(200);
      const raw = await board.clone().arrayBuffer();
      const parsed = JSON.parse(await board.text()) as { jobs?: Array<{ id?: string }> };
      const postingId = parsed.jobs?.find((job) => typeof job.id === 'string')?.id;
      expect(postingId, `${id} has a posting`).toBeTruthy();

      const result = await createMetadataAcquirer()(identity(postingId!, tenant));
      console.log(`[ashby-live] ${id} board=${raw.byteLength}B read=${result?.bytes}B outcome=${result?.outcome}`);
      expect(result?.outcome).toBe('acquired');
      expect(result?.artifact?.text).toBeTruthy();
      expect(result?.bytes ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(raw.byteLength);

      const missing = await createMetadataAcquirer()(identity('00000000-0000-4000-8000-999999999999', tenant));
      expect(missing?.outcome).toBe('identity-mismatch');
    }, 60_000);
  });
});
