import { describe, expect, it, vi } from 'vitest';
import { createSourceOperationsHandler } from '../src/greenhouse-operations-api.js';
import { operationsSources } from '../src/integration-registry.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { SourceCheckpoint } from '../src/types.js';

describe('source operations checkpoint batches', () => {
  it('joins sparse, unordered batches by checkpoint identity without one read per source', async () => {
    const store = new MemoryInternshipStore();
    const sources = operationsSources({ leverAdmissions: [] });
    const figma = sources.find(s => s.sourceId === 'greenhouse-figma')!;
    const mistral = sources.find(s => s.sourceId === 'ashby-mistral-ai')!;
    const now = new Date('2026-10-08T06:00:00.000Z');
    const checkpoint = (sourceId: string, raw: number, eligible: number): SourceCheckpoint => ({
      sourceId, activeExternalIds: [], successfulFetches: 1, lastSuccessAt: now.toISOString(),
      lastRawRowCount: raw, lastRowCount: eligible,
    });
    await store.putCheckpoint(checkpoint(figma.checkpointId, 152, 8));
    await store.putCheckpoint(checkpoint(mistral.checkpointId, 207, 12));
    const one = vi.spyOn(store, 'getCheckpoint').mockRejectedValue(new Error('unbounded per-source read'));
    const batch = vi.spyOn(store, 'getCheckpointsMany').mockImplementation(async ids =>
      ids.map(id => store.checkpoints.get(id)).filter((x): x is SourceCheckpoint => Boolean(x)).reverse());
    const handler = createSourceOperationsHandler({ store, sharedSecret: 'test-operations-key', fleets: {}, now: () => now });
    const result = await handler({ rawPath: '/internal/operations/sources', headers: { 'x-operations-key': 'test-operations-key' },
      requestContext: { http: { method: 'GET' } } });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.sources.find((s: { source: { sourceId: string } }) => s.source.sourceId === figma.sourceId)).toMatchObject({ rawRows: 152, eligibleRows: 8 });
    expect(body.sources.find((s: { source: { sourceId: string } }) => s.source.sourceId === mistral.sourceId)).toMatchObject({ rawRows: 207, eligibleRows: 12 });
    const missing = sources.find(s => s.checkpointId !== figma.checkpointId && s.checkpointId !== mistral.checkpointId)!;
    expect(body.sources.find((s: { source: { sourceId: string } }) => s.source.sourceId === missing.sourceId).rawRows).toBeUndefined();
    expect(batch).toHaveBeenCalledExactlyOnceWith(sources.map(s => s.checkpointId));
    expect(one).not.toHaveBeenCalled();
  });
});
