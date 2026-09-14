import { describe, expect, it, vi } from 'vitest';
import { queueHasBacklog } from '../cloudflare/queue-backlog.js';
import { cloudflareOperationsFleets, cloudflareOperationsQueueClient, dispatchProviders, documentContent, failedStructuredRecoveryHealth, githubSourceRunBlocked, readDocumentUpload, recoveredStructuredSourceHealth, runScheduledPostingIdentityAudit, sendQueueMessageWithin, structuredSourceRunBlocked, validBackfillProvider } from '../cloudflare/worker.js';
import cloudflareWorker from '../cloudflare/worker.js';
import type { Environment } from '../cloudflare/worker.js';
import type { PostingIdentityRepairPlan } from '../src/posting-identity-repair.js';
import type { Queue } from '../cloudflare/types.js';
import { catalogProviderIds, integrationRegistry } from '../src/integration-registry.js';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { D1EmployerStore } from '../cloudflare/employer-store.js';
import { isQuarantinedRecoveryProbeDue, SOURCE_POLL_CADENCE } from '../src/source-poll-cadence.js';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';
import { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';
import { reviewedLeverSources } from '../src/sources/lever-config.js';
import type { ReviewedSourceRecord } from '../src/employer-types.js';
import type { SourceHealth } from '../src/types.js';

const queue = (metrics: Queue['metrics']): Queue => ({
  async send() {},
  async sendBatch() {},
  metrics,
});

describe('Cloudflare scheduled dispatch cost guard', () => {
  it('skips a new polling cycle while prior messages remain queued', async () => {
    await expect(queueHasBacklog(queue(async () => ({ backlogCount: 12, backlogBytes: 1024 })), 'greenhouse')).resolves.toBe(true);
  });

  it('allows a polling cycle when the queue is empty', async () => {
    await expect(queueHasBacklog(queue(async () => ({ backlogCount: 0, backlogBytes: 0 })), 'github')).resolves.toBe(false);
  });

  it('fails open when best-effort queue metrics are unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(queueHasBacklog(queue(async () => { throw new Error('metrics unavailable'); }), 'greenhouse')).resolves.toBe(false);
    vi.restoreAllMocks();
  });

  it.each([
    ['greenhouse', reviewedGreenhouseSources.find((source) => source.status === 'shadow')!],
    ['lever', reviewedLeverSources.find((source) => source.status === 'shadow')!],
    ['ashby', reviewedAshbySources.find((source) => source.status === 'shadow')!],
  ] as const)('serializes an eligible %s recovery probe as forced work', async (provider, source) => {
    const health: SourceHealth = {
      sourceId: source.id,
      state: 'quarantined',
      sourceStatus: 'paused',
      lastAttemptAt: '2026-09-01T00:00:00.000Z',
      quarantinedAt: '2026-09-01T00:00:00.000Z',
      consecutiveFailures: 2,
      durationMs: 20,
    };
    const start = Date.parse(health.lastAttemptAt) + SOURCE_POLL_CADENCE.recoveryProbeIntervalMs;
    const probeAt = Array.from(
      { length: SOURCE_POLL_CADENCE.recoveryProbeJitterMs / SOURCE_POLL_CADENCE.publishedIntervalMs },
      (_, index) => new Date(start + index * SOURCE_POLL_CADENCE.publishedIntervalMs),
    ).find((now) => isQuarantinedRecoveryProbeDue(source.id, health, now))!;
    const record: ReviewedSourceRecord = {
      sourceId: source.id,
      provider,
      config: { ...source },
      evidence: { origin: 'checked-in-reviewed-registry', retained: true },
      state: 'shadow',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const sent: unknown[] = [];
    const workQueue: Queue = {
      async send() {},
      async sendBatch(messages) { sent.push(...messages.map(({ body }) => body)); },
    };
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources').mockResolvedValue([record]);
    vi.spyOn(D1EmployerStore.prototype, 'putReviewedSource').mockResolvedValue();
    vi.spyOn(D1InternshipStore.prototype, 'getCheckpoint').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue(health);
    vi.spyOn(D1InternshipStore.prototype, 'listLeverAdmissions').mockResolvedValue([]);

    try {
      await expect(dispatchProviders({
        DB: {} as Environment['DB'],
        GREENHOUSE_QUEUE: workQueue,
        LEVER_QUEUE: workQueue,
        ASHBY_QUEUE: workQueue,
      } as Environment, provider, probeAt)).resolves.toBe(1);
      expect(sent).toEqual([expect.objectContaining({ sourceId: source.id, force: true })]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('Cloudflare DLQ route authentication', () => {
  it('returns the guarded metadata apply receipt and requires a separate verification request', async () => {
    const apply = vi.spyOn(D1CatalogAdmissionStore.prototype, 'applyRoleMetadataRepair')
      .mockResolvedValue({ changed: 1, occurrencesChanged: 0, projectionRefreshRequired: true });
    const audit = vi.spyOn(D1CatalogAdmissionStore.prototype, 'roleMetadataAudit');
    vi.spyOn(D1InternshipStore.prototype, 'listCatalog').mockResolvedValue([]);
    const projection = vi.spyOn(D1InternshipStore.prototype, 'putCatalogProjection').mockResolvedValue();
    try {
      const response = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/role-metadata/backfill', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': 'secret' },
        body: JSON.stringify({ action: 'apply', repairToken: 'a'.repeat(64), expectedJobs: 1, expectedOccurrences: 0 }),
      }), { OPERATIONS_SHARED_SECRET: 'secret', DB: { prepare: () => ({ async first() { return null; } }) } } as unknown as Environment);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ applied: true, changed: 1, verificationRequired: true,
        verificationPath: '/internal/role-metadata/audit' });
      expect(apply).toHaveBeenCalledOnce();
      expect(projection).toHaveBeenCalledOnce();
      expect(audit).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });

  it('hides metadata omission preview and approval without the operations key', async () => {
    for (const action of ['preview-omission', 'approve-omission']) {
      const response = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/role-metadata/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, jobId: 'test' }),
      }), { OPERATIONS_SHARED_SECRET: 'secret', DB: { prepare: () => ({ async first() { return null; } }) } } as unknown as Environment);
      expect(response.status).toBe(404);
    }
  });
  it('hides the internal operation when the operations key is absent or wrong', async () => {
    const request = new Request('https://intern-notifs.test/internal/operations/dlq', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': 'wrong' },
      body: JSON.stringify({ operation: 'inspect', queue: 'lever' }),
    });
    const response = await cloudflareWorker.fetch(request, {
      OPERATIONS_SHARED_SECRET: 'secret',
      DB: { prepare: () => ({ bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { return { meta: { changes: 0 } }; } }), async batch() { return []; } },
    } as unknown as Environment);
    expect(response.status).toBe(404);
  });
});

describe('Cloudflare queue continuation bounds', () => {
  it('rejects a queue send that never settles so the source message can retry', async () => {
    vi.useFakeTimers();
    try {
      const stalled = queue(async () => ({ backlogCount: 0, backlogBytes: 0 }));
      stalled.send = () => new Promise<void>(() => undefined);
      const sending = expect(sendQueueMessageWithin(stalled, { sourceId: 'source' }, 5_000)).rejects.toThrow('Queue send timed out');
      await vi.advanceTimersByTimeAsync(5_001);
      await sending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Cloudflare scheduled posting identity audit', () => {
  const failedPlan = {
    occurrenceCounts: { confirmed: 4_200, unconfirmed: 68, legacy: 2, quarantined: 1, confirmedCoverage: 4_200 / 4_268 },
    duplicateAlertGroups: 1,
    duplicateJobs: 2,
    gate: {
      passed: false, exactDuplicateGroups: 1, aliasConflicts: 2, untrackedQuarantines: 1,
      presentationBlockers: 3, legacyOccurrences: 2, projectionMismatches: 4, duplicateOccurrenceReferences: 5,
      danglingOccurrenceReferences: 6,
    },
  } as PostingIdentityRepairPlan;

  const coverageRegressionPlan = {
    ...failedPlan,
    occurrenceCounts: { confirmed: 3, unconfirmed: 2, legacy: 0, quarantined: 0, confirmedCoverage: 0.6 },
    duplicateAlertGroups: 0,
    duplicateJobs: 0,
    gate: {
      passed: true, exactDuplicateGroups: 0, aliasConflicts: 0, untrackedQuarantines: 0,
      presentationBlockers: 0, legacyOccurrences: 0, projectionMismatches: 0, duplicateOccurrenceReferences: 0,
      danglingOccurrenceReferences: 0,
    },
  } as PostingIdentityRepairPlan;

  it('logs a sanitized failed gate while disabled and throws after logging when enforcement is active', async () => {
    const disabledLogs: string[] = [];
    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'], IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'false', IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0.98',
    }, { audit: async () => failedPlan, log: (event) => disabledLogs.push(event) })).resolves.toMatchObject({
      status: 'failed', enforcementActive: false, exactDuplicateGroups: 1, aliasConflicts: 2,
      quarantinedOccurrences: 1, presentationBlockers: 3, legacyOccurrences: 2,
      projectionMismatches: 4, duplicateOccurrenceReferences: 5, danglingOccurrenceReferences: 6,
    });
    expect(disabledLogs).toHaveLength(1);
    expect(disabledLogs[0]).not.toContain('repairToken');
    expect(disabledLogs[0]).not.toContain('jobId');

    const enabledLogs: string[] = [];
    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'], IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'true', IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0.98',
    }, { audit: async () => failedPlan, log: (event) => enabledLogs.push(event) }))
      .rejects.toThrow('integrity gate failed');
    expect(enabledLogs).toHaveLength(1);
    expect(JSON.parse(enabledLogs[0]!)).toMatchObject({ status: 'failed', enforcementActive: true });
  });

  it('fails an enforced coverage regression even when the structural gate passes', async () => {
    const shadowLogs: string[] = [];
    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'], IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'false', IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0.9',
    }, { audit: async () => coverageRegressionPlan, log: (event) => shadowLogs.push(event) })).resolves.toMatchObject({
      status: 'failed', enforcementActive: false, confirmedCoverage: 0.6,
      confirmedCoverageFloor: 0.9, coverageRegression: true,
    });

    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'], IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'true', IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0.9',
    }, { audit: async () => coverageRegressionPlan, log: () => undefined })).rejects.toThrow('integrity gate failed');

    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'], IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'true', IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0.5',
    }, { audit: async () => coverageRegressionPlan, log: () => undefined })).resolves.toMatchObject({
      status: 'passed', confirmedCoverageFloor: 0.5, coverageRegression: false,
    });
  });

  it('treats a missing or invalid coverage floor as unavailable gate evidence', async () => {
    const logs: string[] = [];
    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'], IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'false',
    }, { audit: async () => coverageRegressionPlan, log: (event) => logs.push(event) })).resolves.toMatchObject({
      status: 'error', confirmedCoverageFloor: null, coverageRegression: null,
    });
    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'], IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'true', IDENTITY_CONFIRMED_COVERAGE_FLOOR: 'not-a-number',
    }, { audit: async () => coverageRegressionPlan, log: () => undefined })).rejects.toThrow('integrity gate failed');
  });
});

describe('structured source recovery guard', () => {
  const quarantined = {
    sourceId: 'structured-acme', state: 'quarantined' as const, sourceStatus: 'paused' as const,
    lastAttemptAt: '2026-08-26T12:00:00.000Z', consecutiveFailures: 2, durationMs: 4,
    backoffUntil: '2099-01-01T00:00:00.000Z', quarantineReason: 'Invalid schema', quarantinedAt: '2026-08-26T12:00:00.000Z',
    incidentState: 'open' as const,
  };

  it('blocks normal work but lets an explicit recovery probe run', () => {
    expect(structuredSourceRunBlocked(quarantined)).toBe(true);
    expect(structuredSourceRunBlocked(quarantined, true)).toBe(false);
  });

  it('clears quarantine and backoff but keeps a successful recovery paused', () => {
    expect(recoveredStructuredSourceHealth({ ...quarantined, state: 'healthy', lastSuccessAt: '2026-08-26T12:01:00.000Z' }))
      .toMatchObject({ state: 'healthy', sourceStatus: 'paused', consecutiveFailures: 0, incidentState: 'resolved' });
    const recovered = recoveredStructuredSourceHealth({ ...quarantined, state: 'healthy' });
    expect(recovered).not.toHaveProperty('backoffUntil');
    expect(recovered).not.toHaveProperty('quarantineReason');
    expect(recovered).not.toHaveProperty('quarantinedAt');
  });

  it('retains quarantine and pause after a failed recovery probe', () => {
    const failed = { ...quarantined, state: 'degraded' as const, sourceStatus: 'paused' as const,
      lastAttemptAt: '2026-08-26T12:02:00.000Z', consecutiveFailures: 3 };
    expect(failedStructuredRecoveryHealth(quarantined, failed)).toMatchObject({
      state: 'quarantined', sourceStatus: 'paused', quarantineReason: 'Invalid schema',
      quarantinedAt: '2026-08-26T12:00:00.000Z', consecutiveFailures: 3,
    });
  });
});

describe('GitHub source recovery guard', () => {
  it('requires the literal boolean force flag to bypass quarantine', () => {
    const health = { sourceId: 'github-source', state: 'quarantined' as const, sourceStatus: 'paused' as const,
      lastAttemptAt: '2026-08-26T12:00:00.000Z', consecutiveFailures: 2, durationMs: 4 };
    expect(githubSourceRunBlocked(health, undefined)).toBe(true);
    expect(githubSourceRunBlocked(health, 'true')).toBe(true);
    expect(githubSourceRunBlocked(health, true)).toBe(false);
  });
});

describe('Catalog queue setup failures', () => {
  it('ledgers and retries every Greenhouse message when the reviewed-source registry is unavailable', async () => {
    const failureRows: unknown[][] = [];
    const prepare = vi.fn((query: string) => {
      const statement = {
        async first() { return null; },
        bind: (...values: unknown[]) => ({
          async all() {
            if (query.includes('reviewed_source_registry')) throw new Error('D1 DB reset because its code was updated');
            return { results: [] };
          },
          async run() { failureRows.push(values); return { meta: { changes: 1 } }; },
        }),
      };
      return statement;
    });
    const first = { id: 'first', body: { sourceId: 'greenhouse-acme' }, attempts: 2,
      ack: vi.fn(), retry: vi.fn() };
    const second = { id: 'second', body: { sourceId: 'greenhouse-beta' }, attempts: 2,
      ack: vi.fn(), retry: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await cloudflareWorker.queue({ queue: 'intern-notifs-greenhouse', messages: [first, second] }, {
      DB: { prepare, async batch() { return []; } },
    } as unknown as Environment);

    expect(first.retry).toHaveBeenCalledOnce();
    expect(second.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).not.toHaveBeenCalled();
    expect(failureRows).toHaveLength(2);
    expect(failureRows.map((values) => ({ sourceId: values[5], category: values[8], diagnostic: values[9] }))).toEqual([
      { sourceId: 'greenhouse-acme', category: 'persistence', diagnostic: 'D1 DB reset because its code was updated' },
      { sourceId: 'greenhouse-beta', category: 'persistence', diagnostic: 'D1 DB reset because its code was updated' },
    ]);
    vi.restoreAllMocks();
  });
});

describe('Cloudflare operations queue adapter', () => {
  it('validates backfill providers from the registry while retaining structured fleet sharing', () => {
    for (const provider of catalogProviderIds) expect(validBackfillProvider(provider)).toBe(true);
    expect(validBackfillProvider('all')).toBe(true);
    expect(validBackfillProvider('structured')).toBe(true);
    expect(validBackfillProvider('retired-provider')).toBe(false);
  });

  it('reports live work-queue and dead-letter-queue backlogs', async () => {
    const client = cloudflareOperationsQueueClient({
      GREENHOUSE_QUEUE: queue(async () => ({ backlogCount: 7, backlogBytes: 700 })),
      LEVER_QUEUE: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      ASHBY_QUEUE: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      GITHUB_QUEUE: queue(async () => ({ backlogCount: 3, backlogBytes: 300 })),
      GREENHOUSE_DLQ: queue(async () => ({ backlogCount: 2, backlogBytes: 200 })),
      LEVER_DLQ: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      ASHBY_DLQ: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      GITHUB_DLQ: queue(async () => ({ backlogCount: 1, backlogBytes: 100 })),
    });

    await expect(client.send({ input: { QueueUrl: integrationRegistry.greenhouse.queues.work } })).resolves.toMatchObject({
      Attributes: { ApproximateNumberOfMessages: '7' },
    });
    await expect(client.send({ input: { QueueUrl: integrationRegistry.greenhouse.queues.work } })).resolves.not.toMatchObject({
      Attributes: { ApproximateNumberOfMessagesNotVisible: expect.anything() },
    });
    await expect(client.send({ input: { QueueUrl: integrationRegistry.greenhouse.queues.deadLetter } })).resolves.toMatchObject({
      Attributes: { ApproximateNumberOfMessages: '2' },
    });
    await expect(client.send({ input: { QueueUrl: integrationRegistry.github.queues.deadLetter } })).resolves.toMatchObject({
      Attributes: { ApproximateNumberOfMessages: '1' },
    });
  });

  it('reports missing registered bindings without hiding the provider', () => {
    const fleets = cloudflareOperationsFleets({
      GREENHOUSE_QUEUE: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      GREENHOUSE_DLQ: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
    });
    expect(fleets).toMatchObject({
      greenhouse: { queueUrl: integrationRegistry.greenhouse.queues.work, deadLetterQueueUrl: integrationRegistry.greenhouse.queues.deadLetter },
      github: {},
    });
  });
});

describe('Cloudflare document upload bounds', () => {
  it('returns 413 for an oversized declared body before quota or R2 work', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = new Request('https://example.test/me/documents/document-1/content', {
      method: 'PUT',
      headers: { 'Content-Length': String(5 * 1024 * 1024 + 1) },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const all = vi.fn(async () => ({ results: [{ value: JSON.stringify({
      userId: 'user-1', documentId: 'document-1', objectKey: 'private/user-1/document-1', contentType: 'application/pdf',
    }) }] }));
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ all, run })) }));
    const put = vi.fn();

    const response = await documentContent(request, {
      DB: { prepare },
      DOCUMENTS: { put },
    } as unknown as Environment, 'user-1', 'document-1');

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledTimes(2);
    expect(put).not.toHaveBeenCalled();
  });

  it('cancels an undeclared body as soon as streamed bytes cross the limit', async () => {
    const cancel = vi.fn();
    const chunks = [new Uint8Array(5 * 1024 * 1024), new Uint8Array(1)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    });
    const request = new Request('https://example.test/me/documents/document-1/content', {
      method: 'PUT',
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(readDocumentUpload(request)).resolves.toEqual({ tooLarge: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns a body at the exact 5 MiB boundary', async () => {
    const request = new Request('https://example.test/me/documents/document-1/content', {
      method: 'PUT',
      body: new Uint8Array(5 * 1024 * 1024),
    });

    const result = await readDocumentUpload(request);
    expect(result.tooLarge).toBe(false);
    if (!result.tooLarge) expect(result.content.byteLength).toBe(5 * 1024 * 1024);
  });
});
