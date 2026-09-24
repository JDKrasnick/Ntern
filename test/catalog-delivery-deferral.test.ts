import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_DELIVERY_MAX_ATTEMPTS, catalogDeliveryIsDeferred, catalogFailureIsPoison } from '../src/source-poll-cadence.js';
import { QueueMessageDeadlineError } from '../src/sqs-fifo-batch.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import cloudflareWorker, { type Environment } from '../cloudflare/worker.js';

/**
 * Worker.ts owns the deferral decision, so the ATS poll is replaced with a hook
 * that hands `onRecordFailure` the same error the real path would. In
 * particular a message-deadline rejection is raised by `processFifoBatch`
 * around a record, outside the ATS worker's own catch, which is the gap this
 * suite pins.
 */
const greenhouse = vi.hoisted(() => ({ failure: undefined as unknown }));

vi.mock('../src/greenhouse-worker.js', () => ({
  processGreenhouseQueue: async (
    event: { Records: Array<{ messageId: string; body: string }> },
    dependencies: { onRecordFailure?: (record: { messageId: string; body: string }, error: unknown) => Promise<void> },
  ) => {
    for (const record of event.Records) await dependencies.onRecordFailure?.(record, greenhouse.failure);
    return { batchItemFailures: event.Records.map((record) => ({ itemIdentifier: record.messageId })) };
  },
}));

// Restoration runs after the assertions so the queue's ack/retry spies keep
// their call records while the test body reads them.
afterEach(() => {
  greenhouse.failure = undefined;
  vi.restoreAllMocks();
});

vi.mock('../cloudflare/employer-registry.js', () => ({
  reviewedProviderRegistry: async () => ({ greenhouse: [], lever: [], ashby: [] }),
  reviewedStructuredRegistry: async () => [],
}));

const database = () => ({
  async first() { return null; },
  async batch() { return []; },
  prepare: vi.fn(() => ({
    async first() { return null; },
    bind: () => ({
      async all() { return { results: [] }; },
      async run() { return { meta: { changes: 1 } }; },
    }),
  })),
});

const deliver = async (attempts: number, body: Record<string, unknown> = {}) => {
  const message = { id: 'greenhouse-first', body: { sourceId: 'greenhouse-acme', ...body }, attempts,
    ack: vi.fn(), retry: vi.fn() };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await cloudflareWorker.queue({ queue: 'intern-notifs-greenhouse', messages: [message] },
    { DB: database() } as unknown as Environment);
  return message;
};

describe('Catalog delivery deferral', () => {
  it('records deadline failure health and defers the delivery to the dispatcher', async () => {
    const putSourceHealth = vi.spyOn(D1InternshipStore.prototype, 'putSourceHealth').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue(undefined);
    greenhouse.failure = new QueueMessageDeadlineError(300_000);

    const message = await deliver(CATALOG_DELIVERY_MAX_ATTEMPTS);

    expect(putSourceHealth).toHaveBeenCalledOnce();
    const health = putSourceHealth.mock.calls[0]![0];
    expect(health).toMatchObject({ sourceId: 'greenhouse-acme', provider: 'greenhouse', state: 'degraded', consecutiveFailures: 1 });
    expect(health.recentRuns?.[0]).toMatchObject({ failureCategory: 'transport', state: 'failed' });
    // The deadline error is not an "Unknown reviewed"/"Invalid work message"/schema
    // defect, so it is source-scoped work the dispatcher re-issues.
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('records deadline failure health but retries before the final delivery', async () => {
    const putSourceHealth = vi.spyOn(D1InternshipStore.prototype, 'putSourceHealth').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue(undefined);
    greenhouse.failure = new QueueMessageDeadlineError(300_000);

    const message = await deliver(CATALOG_DELIVERY_MAX_ATTEMPTS - 1);

    expect(putSourceHealth).toHaveBeenCalledOnce();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('does not double-write health for a poll failure the ATS worker already recorded', async () => {
    const putSourceHealth = vi.spyOn(D1InternshipStore.prototype, 'putSourceHealth').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue(undefined);
    greenhouse.failure = new Error('fetch failed (404)');

    const message = await deliver(CATALOG_DELIVERY_MAX_ATTEMPTS);

    expect(putSourceHealth).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('still returns a poison failure to the platform', async () => {
    greenhouse.failure = new Error('Unknown reviewed Greenhouse source "ghost"');

    const message = await deliver(CATALOG_DELIVERY_MAX_ATTEMPTS);

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('defers a forced ATS recovery probe the provider dispatcher re-issues', async () => {
    vi.spyOn(D1InternshipStore.prototype, 'putSourceHealth').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue(undefined);
    greenhouse.failure = new QueueMessageDeadlineError(300_000);

    // Unlike GitHub, the ATS dispatcher re-issues a quarantined source on its
    // daily recovery probe, so a forced probe is still safe to defer.
    const message = await deliver(CATALOG_DELIVERY_MAX_ATTEMPTS, { force: true });

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});

describe('Catalog failure classification', () => {
  it('treats unknown sources, malformed work messages, non-Errors, and schema defects as poison', () => {
    expect(catalogFailureIsPoison(new Error('Unknown reviewed Greenhouse source "ghost"'))).toBe(true);
    expect(catalogFailureIsPoison(new Error('Invalid Greenhouse work message'))).toBe(true);
    expect(catalogFailureIsPoison(new Error('D1_ERROR: no such table: reviewed_source_registry'))).toBe(true);
    expect(catalogFailureIsPoison(new Error('D1_ERROR: no such column: source_status'))).toBe(true);
    expect(catalogFailureIsPoison('boom')).toBe(true);
  });

  it('keeps transient source failures deferrable', () => {
    expect(catalogFailureIsPoison(new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'))).toBe(false);
    expect(catalogFailureIsPoison(new QueueMessageDeadlineError(300_000))).toBe(false);
    expect(catalogFailureIsPoison(new Error('fetch failed (404)'))).toBe(false);
  });

  it('defers only a source-scoped failure on its final delivery', () => {
    const overload = () => new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.');
    expect(catalogDeliveryIsDeferred(overload(), 'greenhouse-acme', CATALOG_DELIVERY_MAX_ATTEMPTS)).toBe(true);
    expect(catalogDeliveryIsDeferred(overload(), 'greenhouse-acme', CATALOG_DELIVERY_MAX_ATTEMPTS - 1)).toBe(false);
    expect(catalogDeliveryIsDeferred(overload(), 'greenhouse-acme', undefined)).toBe(false);
    expect(catalogDeliveryIsDeferred(overload(), undefined, CATALOG_DELIVERY_MAX_ATTEMPTS)).toBe(false);
    expect(catalogDeliveryIsDeferred(new Error('Unknown reviewed Greenhouse source "ghost"'), 'ghost', CATALOG_DELIVERY_MAX_ATTEMPTS)).toBe(false);
  });
});
