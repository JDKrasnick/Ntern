import { afterEach, expect, it, vi } from 'vitest';
import { GreenhouseBoardAdapter } from '../src/sources/greenhouse.js';
import { LeverPostingsAdapter } from '../src/sources/lever.js';
import { AshbyPostingsAdapter } from '../src/sources/ashby.js';
import { acmeSource, technicalInternship } from './fixtures/greenhouse.js';
import { normalizeSourceSnapshot, serializeEnvelope } from '../src/ingestion-v2/normalize.js';
import { readSnapshotRows, SNAPSHOT_STREAM_MAX_ROW_BYTES } from '../src/ingestion-v2/stream-snapshot.js';
import { R2IngestionSnapshotStore } from '../cloudflare/ingestion-v2-store.js';
import type { R2Bucket } from '../cloudflare/types.js';
import { officialAdmissionProviderProbe } from '../cloudflare/admission-v2-provider.js';
import { classifyAdmissionFailure } from '../src/ingestion-v2/admission/taxonomy.js';
import { processPosting } from '../src/ingestion/processor.js';
import { extractRoleMetadataEvidence } from '../src/role-metadata.js';

afterEach(() => vi.unstubAllGlobals());
const observedAt = '2026-10-06T17:00:00.000Z';
const id = '11111111-1111-4111-8111-111111111111';
async function board(provider: string, description?: string) {
  if (provider === 'greenhouse') return new GreenhouseBoardAdapter({ source: acmeSource,
    fetchImpl: async () => Response.json({ jobs: [{ ...technicalInternship, content: description ?? '漢'.repeat(360_000) }, { ...technicalInternship, id: 999 }] }),
  }).fetch();
  if (provider === 'lever') return new LeverPostingsAdapter({ id: 'lever-acme', company: 'Acme', site: 'acme',
    fetchImpl: async () => Response.json([{ id, text: 'Software Engineering Intern',
      applyUrl: `https://jobs.lever.co/acme/${id}/apply`, hostedUrl: `https://jobs.lever.co/acme/${id}`,
      descriptionPlain: description ?? 'a'.repeat(1_100_000), categories: { location: 'Remote' } }]),
  }).fetch();
  return new AshbyPostingsAdapter({ source: { id: 'ashby-acme', company: 'Acme',
    identity: { provider: 'ashby', boardKey: 'Acme', apiRegion: 'global' }, careersUrl: 'https://example.com/careers',
    admittedAt: observedAt, evidenceState: 'ownership-verified', allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'published' },
    fetchImpl: async () => Response.json({ apiVersion: '1', jobs: [{ id, title: 'Software Engineering Intern',
      location: 'Remote', isListed: true, employmentType: 'Intern', descriptionPlain: description ?? 'a'.repeat(1_100_000),
      jobUrl: `https://jobs.ashbyhq.com/Acme/${id}`, applyUrl: `https://jobs.ashbyhq.com/Acme/${id}/application` }] }),
  }).fetch();
}
it.each(['greenhouse', 'lever', 'ashby'])('classifies an oversized %s posting before accepting a complete board', async provider => {
  await expect(board(provider)).rejects.toMatchObject({ category: 'capacity' });
});

it.each(['greenhouse', 'lever', 'ashby'])('round-trips a large accepted %s posting through immutable storage and selective reads', async provider => {
  const fetched = await board(provider, provider === 'greenhouse' ? '漢'.repeat(170_000) : 'a'.repeat(900_000));
  expect(fetched.complete).toBe(true);
  const envelope = normalizeSourceSnapshot({ sourceId: fetched.postings[0]!.sourceId, postings: fetched.postings, admissionVersion: 'v1', observedAt });
  const objects = new Map<string, ArrayBuffer>();
  const store = new R2IngestionSnapshotStore({
    async get(key: string) { const body = objects.get(key); return body ? { body: new Response(body).body! } : null; },
    async put(key: string, body: ArrayBuffer) { objects.set(key, body); },
  } as unknown as R2Bucket);
  await store.putSnapshot(envelope);
  const selected = await store.getSnapshotRows(envelope.sourceId, envelope.snapshotHash, [envelope.rows[0]!.externalId]);
  expect(selected.get(envelope.rows[0]!.externalId)).toEqual(envelope.rows[0]);
});

it.each(['lever', 'ashby'])('accepts and reads the exact %s row-byte boundary but rejects one additional byte', async provider => {
  const initial = await board(provider, 'a'.repeat(900_000));
  const normalize = (fetched: Awaited<ReturnType<typeof board>>) => normalizeSourceSnapshot({
    sourceId: fetched.postings[0]!.sourceId, postings: fetched.postings, admissionVersion: 'v1', observedAt,
  });
  const overhead = new TextEncoder().encode(JSON.stringify(normalize(initial).rows[0])).byteLength - 900_000;
  const length = SNAPSHOT_STREAM_MAX_ROW_BYTES - overhead;
  const accepted = normalize(await board(provider, 'a'.repeat(length)));
  expect(new TextEncoder().encode(JSON.stringify(accepted.rows[0])).byteLength).toBe(SNAPSHOT_STREAM_MAX_ROW_BYTES);
  const bytes = new TextEncoder().encode(serializeEnvelope(accepted));
  const result = await readSnapshotRows(new Response(bytes).body!, accepted, [accepted.rows[0]!.externalId]);
  expect(result.rows.get(accepted.rows[0]!.externalId)).toEqual(accepted.rows[0]);
  await expect(board(provider, 'a'.repeat(length + 1))).rejects.toMatchObject({ category: 'capacity' });
});

it('shares one failed tenant request across 25 simultaneous peer probes', async () => {
  const fetcher = vi.fn(async () => new Response('', { status: 503 })); vi.stubGlobal('fetch', fetcher);
  const probe = officialAdmissionProviderProbe({ async resolve() { return ['93.184.216.34']; } });
  const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => probe(`https://apply.workable.com/acme/j/${String(index).padStart(10, '0')}/`)));
  expect(fetcher).toHaveBeenCalledOnce();
  const failures = results.map(result => { expect(result.status).toBe('rejected'); return classifyAdmissionFailure((result as PromiseRejectedResult).reason); });
  expect(failures.filter(failure => failure.retryWithoutAttempt)).toHaveLength(24);
  expect(failures.every(failure => failure.classification === 'upstream-server-error')).toBe(true);
});

it.each([
  'Our internship runs in Summer 2027 and is open to students graduating in Spring 2028.',
  'This Summer internship 2027 welcomes students graduating in Spring 2028.',
  'Applicants graduating in Spring 2028 can join the program in Summer 2027.',
])('keeps independent hiring-season evidence across both parsers: %s', description => {
  const title = 'Software Engineering Intern';
  const posting = { sourceId: 'source', externalId: 'role', sourceUrl: 'https://example.com/board', fetchedAt: observedAt,
    employer: { name: 'Acme', authority: 'reviewed-registry' as const }, title,
    content: [{ kind: 'description' as const, format: 'plain' as const, value: description }], locations: ['Remote'],
    applyUrl: 'https://example.com/job', sourceState: 'open' as const, lifecycleAuthority: 'title' as const };
  const listing = processPosting(posting).listing;
  const evidence = extractRoleMetadataEvidence({ artifact: { title, text: description }, sourceClass: 'official-page',
    sourceId: 'source', sourceUrl: posting.applyUrl, observedAt, exactPosting: true });
  expect({ processor: listing?.season, metadata: evidence?.season?.value }).toEqual({ processor: 'summer-2027', metadata: { term: 'summer', year: 2027 } });
});

it.each(Array.from({ length: 20 }, (_, index) => index + 1))('validates a near-limit UTF-8 row across arbitrary stream/header boundaries (seed %s)', async seed => {
  const fetched = await new GreenhouseBoardAdapter({ source: acmeSource, fetchImpl: async () => Response.json({ jobs: [{ ...technicalInternship, content: 'é漢🦘'.repeat(25_000) }, { ...technicalInternship, id: 999 }] }) }).fetch();
  const envelope = normalizeSourceSnapshot({ sourceId: acmeSource.id, postings: fetched.postings, admissionVersion: 'v1', observedAt });
  const entries = Object.entries(envelope); const ordered = Object.fromEntries([...entries.slice(seed % entries.length), ...entries.slice(0, seed % entries.length)]);
  const bytes = new TextEncoder().encode(JSON.stringify(ordered)); let offset = 0, state = seed;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) return controller.close();
    state = (state * 1664525 + 1013904223) >>> 0; const end = Math.min(bytes.length, offset + 1 + state % 8192);
    controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } });
  const selected = await readSnapshotRows(stream, envelope, ['999']);
  expect([...selected.rows.keys()]).toEqual(['999']);
  expect(selected.bytes).toBe(new TextEncoder().encode(serializeEnvelope(envelope)).length);
});
