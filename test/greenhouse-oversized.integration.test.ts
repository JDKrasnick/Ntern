import { describe, expect, it } from 'vitest';
import { Poller } from '../src/poll.js';
import { MemoryInternshipStore } from '../src/store.js';
import { GREENHOUSE_DETAILS_PER_DELIVERY, GREENHOUSE_RESPONSE_MAX_BYTES, GreenhouseBoardAdapter } from '../src/sources/greenhouse.js';
import { acmeSource, technicalInternship } from './fixtures/greenhouse.js';

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

    const first = await new Poller([adapter], store).poll();
    expect(first.continuationSources).toEqual([acmeSource.id]);
    expect(await store.getSourceOccurrences(acmeSource.id)).toHaveLength(GREENHOUSE_DETAILS_PER_DELIVERY);

    const second = await new Poller([adapter], store).poll();
    expect(second.continuationSources).toEqual([]);
    expect(fullBoardRequests).toBe(1);
    const persistedContentHashes = (await store.getSourceOccurrences(acmeSource.id))
      .map((item) => item.occurrence.shadowContentHash);
    expect(persistedContentHashes).toHaveLength(jobs.length);
    // The source occurrence hashes normalize the title and exact description.
    // A continuation that rewrote its predecessors from the index would leave
    // one shared empty-description hash instead of one per fetched document.
    expect(new Set(persistedContentHashes).size).toBe(jobs.length);
  });
});
