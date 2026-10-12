import { describe, expect, it } from 'vitest';
import { Poller } from '../src/poll.js';
import { MemoryInternshipStore } from '../src/store.js';
import { GREENHOUSE_DETAILS_PER_DELIVERY, GREENHOUSE_RESPONSE_MAX_BYTES, GreenhouseBoardAdapter } from '../src/sources/greenhouse.js';
import { acmeSource, technicalInternship } from './fixtures/greenhouse.js';
import { normalizeSourceSnapshot, parseEnvelope, serializeEnvelope } from '../src/ingestion-v2/normalize.js';
import type { ShadowDiscoveryInput } from '../src/ingestion-v2/types.js';
import { planSnapshotDiff } from '../src/ingestion-v2/diff.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function oversizedResponse(): Response {
  const chunk = new Uint8Array(65_536).fill(97);
  let sent = 0;
  const total = GREENHOUSE_RESPONSE_MAX_BYTES + chunk.byteLength;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const next = Math.min(chunk.byteLength, total - sent);
      sent += next;
      controller.enqueue(next === chunk.byteLength ? chunk : chunk.slice(0, next));
    },
  }, { highWaterMark: 0 }));
}

describe('oversized Greenhouse board integration', () => {
  it('refreshes an older discovery checkpoint once before reusing its conditional validator', async () => {
    const requests: RequestInit[] = [];
    const adapter = new GreenhouseBoardAdapter({ source: acmeSource, captureDiscoveryIndex: true,
      fetchImpl: async (input, init) => {
        expect(new URL(String(input)).hostname).toBe('boards-api.greenhouse.io');
        requests.push(init!);
        return requests.length === 1
          ? new Response(JSON.stringify({ jobs: [technicalInternship] }), { headers: { etag: 'index-etag' } })
          : new Response(null, { status: 304 });
      } });
    const first = await adapter.fetch({ sourceId: acmeSource.id, etag: 'index-etag', successfulFetches: 1 });
    expect(new Headers(requests[0]!.headers).get('if-none-match')).toBeNull();
    expect(first.checkpoint.greenhouseDiscoveryIndexVersion).toBe(1);
    expect(first.discoveryPostings).toHaveLength(1);
    await adapter.fetch(first.checkpoint);
    expect(new Headers(requests[1]!.headers).get('if-none-match')).toBe('index-etag');
  });
  it('keeps full-response descriptions out of discovery while preserving legacy content', async () => {
    const jobs = Array.from({ length: 12 }, (_, i) => ({ ...technicalInternship,
      id: String(80_000 + i), internal_job_id: 80_000 + i,
      absolute_url: `https://job-boards.greenhouse.io/acmerobotics/jobs/${80_000 + i}`,
      content: `<p>Unique full description ${i}. ${'Software internship requirements. '.repeat(150)}</p>`,
    }));
    const adapter = new GreenhouseBoardAdapter({ source: acmeSource,
      fetchImpl: async () => jsonResponse({ jobs }) });
    const result = await adapter.fetch();
    expect(result.postings.map(posting => posting.content[0]!.value)).toEqual(jobs.map(job => job.content));
    expect(result.discoveryPostings).toHaveLength(jobs.length);
    expect(result.discoveryPostings!.every(posting => posting.contentCompleteness === 'index-only'
      && posting.content.every(part => part.value === ''))).toBe(true);
    expect(result.discoveryProcessed).toBe(result.processed);
    const envelope = normalizeSourceSnapshot({ sourceId: acmeSource.id, postings: result.discoveryPostings!,
      admissionVersion: 'v1', observedAt: '2026-10-12T18:00:00.000Z' });
    expect(serializeEnvelope(envelope).length).toBeLessThan(JSON.stringify({ jobs }).length / 2);
  });
  it('persists every detail slice without replacing earlier descriptions from the complete index', async () => {
    const jobs = Array.from({ length: GREENHOUSE_DETAILS_PER_DELIVERY + 1 }, (_, index) => ({
      ...technicalInternship,
      id: String(90_000 + index),
      internal_job_id: 90_000 + index,
      absolute_url: `https://job-boards.greenhouse.io/acmerobotics/jobs/${90_000 + index}`,
      content: `<p>Unique persisted description ${index}</p>`,
    }));
    let fullBoardRequests = 0;
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        const detailId = /\/jobs\/(\d+)$/.exec(url.pathname)?.[1];
        if (detailId) return jsonResponse(jobs.find((job) => String(job.id) === detailId));
        if (url.searchParams.get('content') === 'false') return jsonResponse({ jobs });
        fullBoardRequests += 1;
        return oversizedResponse();
      },
    });
    const store = new MemoryInternshipStore();
    const discoveries: ShadowDiscoveryInput[] = [];
    const poller = new Poller([adapter], store, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, {
        isEnabledForSource: () => true,
        async discover(input) { discoveries.push(input); return { completed: true }; },
      });

    const first = await poller.poll();
    expect(first.continuationSources).toEqual([acmeSource.id]);
    expect(await store.getSourceOccurrences(acmeSource.id)).toHaveLength(GREENHOUSE_DETAILS_PER_DELIVERY);

    const second = await poller.poll();
    expect(second.continuationSources).toEqual([]);
    expect(fullBoardRequests).toBe(1);
    const persistedContentHashes = (await store.getSourceOccurrences(acmeSource.id))
      .map((item) => item.occurrence.shadowContentHash);
    expect(persistedContentHashes).toHaveLength(jobs.length);
    // The source occurrence hashes normalize the title and exact description.
    // A continuation that rewrote its predecessors from the index would leave
    // one shared empty-description hash instead of one per fetched document.
    expect(new Set(persistedContentHashes).size).toBe(jobs.length);
    expect(discoveries).toHaveLength(2);
    const snapshots = discoveries.map(input => normalizeSourceSnapshot(input));
    for (const [index, input] of discoveries.entries()) {
      expect(input.postings.map(posting => posting.externalId).sort()).toEqual(jobs.map(job => String(job.id)).sort());
      expect(input.processed.counts.raw).toBe(jobs.length);
      expect(input.postings.every(posting => posting.contentCompleteness === 'index-only'
        && posting.content.every(part => part.value === ''))).toBe(true);
      const snapshot = snapshots[index]!;
      expect(parseEnvelope(serializeEnvelope(snapshot), {
        sourceId: snapshot.sourceId, snapshotHash: snapshot.snapshotHash,
      }).rows).toHaveLength(jobs.length);
    }
    expect(snapshots[0]!.snapshotHash).toBe(snapshots[1]!.snapshotHash);
    const diff = planSnapshotDiff({
      sourceId: acmeSource.id, snapshotHash: snapshots[1]!.snapshotHash,
      admissionVersion: discoveries[1]!.admissionVersion, complete: true, now: discoveries[1]!.now,
      rows: snapshots[1]!.rows,
      ledger: snapshots[0]!.rows.map(row => ({ externalId: row.externalId, materialHash: row.materialHash,
        snapshotHash: snapshots[0]!.snapshotHash, attemptCount: 0,
        admissionVersion: discoveries[0]!.admissionVersion, state: 'settled', consecutiveOmissions: 0 })),
    });
    expect(diff.omissionUpdates).toEqual([]);
    expect(diff.counts.unchanged).toBe(jobs.length);
  });
});
