import { describe, expect, it, vi } from 'vitest';
import { cloudflareOperationsFleets, cloudflareOperationsQueueClient, d1QueueRetryDelay, d1TrafficWorkloadForQueue, dispatchProviders, documentContent, dnsJson, failedStructuredRecoveryHealth, githubSourceRunBlocked, isLowImpactPostingIdentityRequest, overduePublishedSourceIds, readDocumentUpload, recoveredStructuredSourceHealth, resumeCompilerPoolName, resumeCompilerRequest, runScheduledPostingIdentityAudit, sendQueueMessageWithin, structuredSourceRunBlocked, validBackfillProvider } from '../cloudflare/worker.js';
import cloudflareWorker from '../cloudflare/worker.js';
import type { Environment } from '../cloudflare/worker.js';
import type { PostingIdentityRepairPlan } from '../src/posting-identity-repair.js';
import type { D1PreparedStatement, Queue } from '../cloudflare/types.js';
import { catalogProviderIds, integrationRegistry } from '../src/integration-registry.js';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore, D1UserStore } from '../cloudflare/d1-store.js';
import { D1EmployerStore } from '../cloudflare/employer-store.js';
import { CATALOG_DELIVERY_MAX_ATTEMPTS, isQuarantinedRecoveryProbeDue, SOURCE_POLL_CADENCE } from '../src/source-poll-cadence.js';
import { GITHUB_RESOLUTION_ROWS_PER_DELIVERY } from '../src/poll.js';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';
import { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';
import { reviewedLeverSources } from '../src/sources/lever-config.js';
import { defaultSources } from '../src/sources/index.js';
import type { ReviewedSourceRecord } from '../src/employer-types.js';
import type { SourceHealth } from '../src/types.js';

// The GitHub queue consumer delegates the poll itself to the runtime command;
// the continuation decision, the re-enqueue, and the ack are the consumer's own
// contract, so the poll result is supplied instead of fetched.
const runtime = vi.hoisted(() => ({ runRuntimeCommand: vi.fn<(command: string, dependencies: { sources?: Array<{ id: string }>; maxListingsPerSourceRun?: number }) => Promise<unknown>>() }));
vi.mock('../src/runtime.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runRuntimeCommand: runtime.runRuntimeCommand,
}));

const queue = (metrics: Queue['metrics']): Queue => ({
  async send() {},
  async sendBatch() {},
  metrics,
});

describe('Resume compiler transport', () => {
  it('sends an explicit UTF-8 byte length to the bounded compiler server', async () => {
    const request = resumeCompilerRequest('Résumé – PDF');
    expect(request.headers.get('content-type')).toBe('application/x-tex');
    expect(request.headers.get('content-length')).toBe(String(new TextEncoder().encode('Résumé – PDF').byteLength));
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new TextEncoder().encode('Résumé – PDF'));
  });

  it('maps arbitrary resume digests onto the bounded compiler instance pool', () => {
    expect(resumeCompilerPoolName('00000000abcdef12')).toBe('resume-pdf-compiler-0');
    expect(resumeCompilerPoolName('00000001abcdef12')).toBe('resume-pdf-compiler-1');
    expect(resumeCompilerPoolName('ffffffffabcdef12')).toBe('resume-pdf-compiler-1');
    expect(() => resumeCompilerPoolName('not-a-digest')).toThrow(/digest/u);
  });
});

const publishedGreenhouseRecords: ReviewedSourceRecord[] = reviewedGreenhouseSources
  .filter((source) => source.status === 'published')
  .map((source) => ({
    sourceId: source.id, provider: 'greenhouse', config: { ...source },
    evidence: { origin: 'checked-in-reviewed-registry', retained: true },
    state: 'active', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }));

describe('Cloudflare scheduled dispatch leases', () => {
  it('assigns every D1-backed queue a traffic-observation priority', () => {
    expect(d1TrafficWorkloadForQueue('intern-notifs-greenhouse')).toMatchObject({ workload: 'catalog:greenhouse', priority: 'P0' });
    expect(d1TrafficWorkloadForQueue('intern-notifs-destination-verification')).toEqual({ workload: 'destination-verification', priority: 'P1' });
    expect(d1TrafficWorkloadForQueue('intern-notifs-shadow-extraction')).toEqual({ workload: 'shadow-extraction', priority: 'P2' });
  });

  it.each([
    ['D1_ERROR: D1 DB is overloaded. Requests queued for too long.', 60, 300],
    ['D1_ERROR: internal error; reference = 6hi9i83lajvi9r65mtnuni1t', 120, 600],
  ])('paces a D1 queue-boundary retry for %s', (message, firstDelay, laterDelay) => {
    expect(d1QueueRetryDelay(new Error(message), 1)).toBe(firstDelay);
    expect(d1QueueRetryDelay(new Error(message), 2)).toBe(laterDelay);
  });

  it('does not pace a queue retry for a reconnect error or an unrelated failure', () => {
    expect(d1QueueRetryDelay(new Error('D1_ERROR: Connection closed: this D1 DB instance is no longer active. Reconnect or retry the request.'))).toBeUndefined();
    expect(d1QueueRetryDelay(new Error('UNIQUE constraint failed'))).toBeUndefined();
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
    vi.spyOn(D1InternshipStore.prototype, 'getSourceDispatchesMany').mockResolvedValue([]);
    vi.spyOn(D1InternshipStore.prototype, 'putSourceDispatches').mockResolvedValue();
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

  it('dispatches a due source while the provider queue reports a backlog', async () => {
    const record = publishedGreenhouseRecords[0]!;
    const sent: unknown[] = [];
    const workQueue = queue(async () => ({ backlogCount: 50, backlogBytes: 5_000 }));
    workQueue.sendBatch = async (messages) => { sent.push(...messages.map(({ body }) => body)); };
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources').mockResolvedValue([record]);
    vi.spyOn(D1EmployerStore.prototype, 'putReviewedSource').mockResolvedValue();
    vi.spyOn(D1InternshipStore.prototype, 'getCheckpoint').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceDispatchesMany').mockResolvedValue([]);
    const written = vi.spyOn(D1InternshipStore.prototype, 'putSourceDispatches').mockResolvedValue();
    try {
      const now = new Date('2026-09-15T16:42:00.000Z');
      await expect(dispatchProviders({ DB: {} as Environment['DB'], GREENHOUSE_QUEUE: workQueue } as Environment, 'greenhouse', now)).resolves.toBe(1);
      expect(sent).toEqual([expect.objectContaining({ sourceId: record.sourceId })]);
      expect(written).toHaveBeenCalledWith([{ sourceId: record.sourceId, provider: 'greenhouse', dispatchedAt: now.toISOString() }]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('suppresses only the sources whose message is still in flight', async () => {
    const [first, second] = publishedGreenhouseRecords;
    const sent: unknown[] = [];
    const workQueue = queue(async () => ({ backlogCount: 50, backlogBytes: 5_000 }));
    workQueue.sendBatch = async (messages) => { sent.push(...messages.map(({ body }) => body)); };
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources').mockResolvedValue(publishedGreenhouseRecords.slice(0, 2));
    vi.spyOn(D1EmployerStore.prototype, 'putReviewedSource').mockResolvedValue();
    vi.spyOn(D1InternshipStore.prototype, 'getCheckpoint').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceDispatchesMany').mockResolvedValue([
      { sourceId: first!.sourceId, provider: 'greenhouse', dispatchedAt: '2026-09-15T16:42:00.000Z' },
    ]);
    const written = vi.spyOn(D1InternshipStore.prototype, 'putSourceDispatches').mockResolvedValue();
    try {
      const now = new Date('2026-09-15T16:50:00.000Z');
      await expect(dispatchProviders({ DB: {} as Environment['DB'], GREENHOUSE_QUEUE: workQueue } as Environment, 'greenhouse', now)).resolves.toBe(1);
      expect(sent).toEqual([expect.objectContaining({ sourceId: second!.sourceId })]);
      expect(written).toHaveBeenCalledWith([{ sourceId: second!.sourceId, provider: 'greenhouse', dispatchedAt: now.toISOString() }]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('re-dispatches a source whose marker is older than one cadence', async () => {
    const record = publishedGreenhouseRecords[0]!;
    const sent: unknown[] = [];
    const workQueue = queue(async () => ({ backlogCount: 50, backlogBytes: 5_000 }));
    workQueue.sendBatch = async (messages) => { sent.push(...messages.map(({ body }) => body)); };
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources').mockResolvedValue([record]);
    vi.spyOn(D1EmployerStore.prototype, 'putReviewedSource').mockResolvedValue();
    vi.spyOn(D1InternshipStore.prototype, 'getCheckpoint').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceDispatchesMany').mockResolvedValue([{
      sourceId: record.sourceId, provider: 'greenhouse',
      dispatchedAt: new Date(Date.parse('2026-09-15T16:50:00.000Z') - SOURCE_POLL_CADENCE.publishedIntervalMs - 1).toISOString(),
    }]);
    vi.spyOn(D1InternshipStore.prototype, 'putSourceDispatches').mockResolvedValue();
    try {
      await expect(dispatchProviders({ DB: {} as Environment['DB'], GREENHOUSE_QUEUE: workQueue } as Environment, 'greenhouse',
        new Date('2026-09-15T16:50:00.000Z'))).resolves.toBe(1);
      expect(sent).toEqual([expect.objectContaining({ sourceId: record.sourceId })]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not suppress a source whose attempt completed after its dispatch', async () => {
    const record = publishedGreenhouseRecords[0]!;
    const sent: unknown[] = [];
    const workQueue = queue(async () => ({ backlogCount: 50, backlogBytes: 5_000 }));
    workQueue.sendBatch = async (messages) => { sent.push(...messages.map(({ body }) => body)); };
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources').mockResolvedValue([record]);
    vi.spyOn(D1EmployerStore.prototype, 'putReviewedSource').mockResolvedValue();
    vi.spyOn(D1InternshipStore.prototype, 'getCheckpoint').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue({
      sourceId: record.sourceId, lastAttemptAt: '2026-09-15T16:44:00.000Z', consecutiveFailures: 0, durationMs: 90,
    });
    vi.spyOn(D1InternshipStore.prototype, 'getSourceDispatchesMany').mockResolvedValue([
      { sourceId: record.sourceId, provider: 'greenhouse', dispatchedAt: '2026-09-15T16:42:00.000Z' },
    ]);
    vi.spyOn(D1InternshipStore.prototype, 'putSourceDispatches').mockResolvedValue();
    try {
      await expect(dispatchProviders({ DB: {} as Environment['DB'], GREENHOUSE_QUEUE: workQueue } as Environment, 'greenhouse',
        new Date('2026-09-15T16:50:00.000Z'))).resolves.toBe(1);
      expect(sent).toEqual([expect.objectContaining({ sourceId: record.sourceId })]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reports the published sources that missed a scheduled interval', async () => {
    const now = new Date('2026-09-15T18:00:00.000Z');
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealthMany').mockResolvedValue([
      { sourceId: 'slipped', lastAttemptAt: '2026-09-15T16:00:00.000Z', consecutiveFailures: 0, durationMs: 10 },
      { sourceId: 'current', lastAttemptAt: '2026-09-15T17:45:00.000Z', consecutiveFailures: 0, durationMs: 10 },
      { sourceId: 'paused', lastAttemptAt: '2026-09-15T16:00:00.000Z', sourceStatus: 'paused', consecutiveFailures: 0, durationMs: 10 },
    ]);
    try {
      await expect(overduePublishedSourceIds(new D1InternshipStore({} as Environment['DB']), [
        { id: 'slipped', status: 'published' }, { id: 'current', status: 'published' },
        { id: 'paused', status: 'published' }, { id: 'never', status: 'published' },
        { id: 'quiet-shadow', status: 'shadow' },
      ], now)).resolves.toEqual(['slipped']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('dispatches a due source on the scheduled cron while the queue reports a backlog', async () => {
    const record = publishedGreenhouseRecords[0]!;
    const sent: unknown[] = [];
    const workQueue = queue(async () => ({ backlogCount: 50, backlogBytes: 5_000 }));
    workQueue.sendBatch = async (messages) => { sent.push(...messages.map(({ body }) => body)); };
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources').mockResolvedValue([record]);
    vi.spyOn(D1EmployerStore.prototype, 'putReviewedSource').mockResolvedValue();
    vi.spyOn(D1InternshipStore.prototype, 'getCheckpoint').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue(undefined);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealthMany').mockResolvedValue([]);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceDispatchesMany').mockResolvedValue([]);
    vi.spyOn(D1InternshipStore.prototype, 'putSourceDispatches').mockResolvedValue();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await cloudflareWorker.scheduled({
        cron: '12,42 * * * *', scheduledTime: Date.parse('2026-09-15T16:42:00.000Z'),
      } as Parameters<typeof cloudflareWorker.scheduled>[0], {
        DB: { prepare: () => ({ async first() { return null; } }) },
        GREENHOUSE_QUEUE: workQueue,
      } as unknown as Environment);
      expect(sent).toEqual([expect.objectContaining({ sourceId: record.sourceId })]);
      expect(logs).toHaveBeenCalledWith(expect.stringContaining('"event":"provider_dispatch_complete"'));
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('Cloudflare maintenance cron', () => {
  it('rebuilds the catalog projection even when another maintenance step fails', async () => {
    // The projection is the Roles feed's whole source of truth: while a failing
    // verification or alert email could abort this cron before the refresh ran,
    // the feed served a day-old snapshot whose groups duplicated live roles.
    vi.spyOn(D1InternshipStore.prototype, 'listCatalog').mockResolvedValue([]);
    const projection = vi.spyOn(D1InternshipStore.prototype, 'putCatalogProjection').mockResolvedValue();
    const failing = vi.spyOn(D1CatalogAdmissionStore.prototype, 'listActiveIncidents').mockRejectedValue(new Error('Resend returned HTTP 422'));
    const metadata = vi.spyOn(D1CatalogAdmissionStore.prototype, 'metadataVerificationCandidates');
    vi.spyOn(D1InternshipStore.prototype, 'listPendingProviderShadowVerifications').mockResolvedValue([]);
    vi.spyOn(D1InternshipStore.prototype, 'pendingSms').mockResolvedValue([]);
    vi.spyOn(D1UserStore.prototype, 'activeDevices').mockResolvedValue([]);
    vi.spyOn(D1UserStore.prototype, 'activePreferences').mockResolvedValue([]);
    vi.spyOn(D1UserStore.prototype, 'pendingReceipts').mockResolvedValue([]);
    vi.spyOn(D1UserStore.prototype, 'retryableReceipts').mockResolvedValue([]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await cloudflareWorker.scheduled({
        cron: '9-59/10 * * * *', scheduledTime: Date.parse('2026-09-17T17:09:00.000Z'),
      } as Parameters<typeof cloudflareWorker.scheduled>[0], {
        DB: { prepare: () => ({ bind: () => ({ async first() { return { count: 2 }; } }), async first() { return null; } }) },
        DESTINATION_VERIFICATION_QUEUE: queue(undefined),
        DESTINATION_VERIFICATION_DLQ: queue(undefined),
      } as unknown as Environment);
      expect(failing).toHaveBeenCalled();
      expect(projection).toHaveBeenCalledOnce();
      expect(metadata).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('"step":"admission_verification_warnings"'));
      expect(logs).toHaveBeenCalledWith(expect.stringContaining('"event":"cloudflare_maintenance_complete"'));
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

describe('resume artifact rollout boundary', () => {
  it('hides artifact content, source, and previews while resume tailoring is disabled', async () => {
    for (const suffix of ['content', 'source', 'preview/1']) {
      const response = await cloudflareWorker.fetch(
        new Request(`https://intern-notifs.test/me/resume-artifacts/artifact/${suffix}`),
        { RESUME_TUNER_ENABLED: 'false', PUBLIC_API_URL: 'https://intern-notifs.test', DB: { prepare: () => ({ async first() { return null; } }) } } as unknown as Environment,
      );
      expect(response.status).toBe(404);
    }
  });

  it('serves the authenticated owner PDF, LaTeX source, and rendered preview privately', async () => {
    const artifact = {
      userId: 'student', artifactId: 'artifact', draftId: 'draft', objectKey: 'private/student/resume.pdf',
      texObjectKey: 'private/student/resume.tex', previewObjectKeys: ['private/student/preview-1.png'],
      templateVersion: 'v1', compilerVersion: 'compiler', resumeSpecHash: 'hash', pageCount: 1, createdAt: 'now',
    };
    const getArtifact = vi.spyOn(D1UserStore.prototype, 'getResumeArtifact').mockResolvedValue(artifact);
    const getObject = vi.fn(async (key: string) => ({ body: new TextEncoder().encode(key) }));
    const statement = { bind() { return this; }, async first() { return { user_id: 'student' }; } };
    const env = {
      RESUME_TUNER_ENABLED: 'true', PUBLIC_API_URL: 'https://intern-notifs.test',
      AUTH_SESSION_SECRET: 'a-production-length-session-secret-value',
      DB: { prepare: () => statement }, DOCUMENTS: { get: getObject },
    } as unknown as Environment;
    try {
      for (const [suffix, contentType, objectKey] of [
        ['content', 'application/pdf', artifact.objectKey],
        ['source', 'text/plain; charset=utf-8', artifact.texObjectKey],
        ['preview/1', 'image/png', artifact.previewObjectKeys[0]],
      ] as const) {
        const response = await cloudflareWorker.fetch(new Request(`https://intern-notifs.test/me/resume-artifacts/artifact/${suffix}`, {
          headers: { Authorization: 'Bearer session-token' },
        }), env);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(contentType);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(await response.text()).toBe(objectKey);
      }
      expect(getArtifact).toHaveBeenCalledTimes(3);
      expect(getObject).toHaveBeenCalledTimes(3);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('Cloudflare company icon route', () => {
  it('resolves a public icon through the reviewed canonical employer record', async () => {
    const db = {
      prepare(query: string) {
        return { bind() { return this; }, async first() {
          if (query.includes('canonical_employers')) return {
            id: 'acme', display_name: 'Acme', icon_key: 'company-icons/acme/logo-v1.webp',
            reviewed_at: '2026-09-24T00:00:00.000Z', reviewed_by: 'reviewer',
          };
          return null;
        } };
      },
    };
    const response = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/company-icons/acme'), {
      DB: db,
      DOCUMENTS: { async get(key: string) {
        return key === 'company-icons/acme/logo-v1.webp'
          ? { body: new ReadableStream({ start(controller) { controller.close(); } }), size: 7, httpMetadata: { contentType: 'image/webp' } }
          : null;
      } },
    } as unknown as Environment);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
  });
});

describe('Cloudflare bulk operation admission', () => {
  it('exposes a protected read-only preflight', async () => {
    const empty = queue(async () => ({ backlogCount: 0, backlogBytes: 0 }));
    const db = { prepare(query: string) { return { bind() { return this; },
      async first() { return query.includes('queue_failure_events') ? { count: 0 } : null; } }; } };
    const env = { OPERATIONS_SHARED_SECRET: 'secret', DB: db,
      GREENHOUSE_QUEUE: empty, LEVER_QUEUE: empty, ASHBY_QUEUE: empty, GITHUB_QUEUE: empty,
      GMAIL_QUEUE: empty, DESTINATION_VERIFICATION_QUEUE: empty, SHADOW_EXTRACTION_QUEUE: empty,
    } as unknown as Environment;
    const url = 'https://intern-notifs.test/internal/operations/bulk-window';
    expect((await cloudflareWorker.fetch(new Request(url), env)).status).toBe(404);
    const response = await cloudflareWorker.fetch(new Request(url, { headers: { 'X-Operations-Key': 'secret' } }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
  });

  it.each(['/internal/posting-identity-repair', '/internal/catalog-quality-backfill'])(
    'returns a retryable response before scanning %s when a work queue is busy', async (path) => {
      const empty = queue(async () => ({ backlogCount: 0, backlogBytes: 0 }));
      const busy = queue(async () => ({ backlogCount: 1, backlogBytes: 1 }));
      const db = { prepare(query: string) { return { bind() { return this; },
        async first() { return query.includes('queue_failure_events') ? { count: 0 } : null; } }; } };
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const response = await cloudflareWorker.fetch(new Request(`https://intern-notifs.test${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': 'secret' }, body: '{}',
        }), { OPERATIONS_SHARED_SECRET: 'secret', DB: db,
          GREENHOUSE_QUEUE: empty, LEVER_QUEUE: empty, ASHBY_QUEUE: empty, GITHUB_QUEUE: busy,
          GMAIL_QUEUE: empty, DESTINATION_VERIFICATION_QUEUE: empty, SHADOW_EXTRACTION_QUEUE: empty,
        } as unknown as Environment);
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('300');
        expect(await response.json()).toMatchObject({ reason: 'queue-busy', queues: ['github'] });
      } finally { warning.mockRestore(); }
    },
  );

  it('permits only capped identity and occurrence repairs alongside queued work', () => {
    expect(isLowImpactPostingIdentityRequest({ audit: true })).toBe(true);
    expect(isLowImpactPostingIdentityRequest({ scope: 'identity', duplicateGroupsOnly: true })).toBe(true);
    expect(isLowImpactPostingIdentityRequest({ scope: 'identity', apply: true, applyBatch: {
      jobIds: ['one'], contextRows: [], occurrenceKeys: [],
    } })).toBe(true);
    expect(isLowImpactPostingIdentityRequest({ scope: 'identity', apply: true, finalize: true, applyBatch: {
      jobIds: ['one'], contextRows: [], occurrenceKeys: [],
    } })).toBe(false);
    expect(isLowImpactPostingIdentityRequest({ scope: 'identity', apply: true, applyBatch: {
      jobIds: Array.from({ length: 100 }, (_, index) => String(index)), contextRows: Array.from({ length: 125 }, () => ({})), occurrenceKeys: Array.from({ length: 125 }, () => []),
    } })).toBe(true);
    expect(isLowImpactPostingIdentityRequest({ scope: 'identity', apply: true, applyBatch: {
      jobIds: Array.from({ length: 101 }, (_, index) => String(index)), contextRows: [], occurrenceKeys: [],
    } })).toBe(false);
    expect(isLowImpactPostingIdentityRequest({ scope: 'occurrences' })).toBe(true);
    expect(isLowImpactPostingIdentityRequest({ scope: 'occurrences', apply: true, finalize: false, applyBatch: {
      jobIds: ['one'], contextRows: [], occurrenceKeys: [['simplify-summer-2026', 'README.md:1']],
    } })).toBe(true);
    // An omitted finalize defers the R2 rebuild exactly like an explicit false.
    expect(isLowImpactPostingIdentityRequest({ scope: 'occurrences', apply: true, applyBatch: {
      jobIds: ['one'], contextRows: [], occurrenceKeys: [],
    } })).toBe(true);
    expect(isLowImpactPostingIdentityRequest({ scope: 'occurrences', apply: true, finalize: true, applyBatch: {
      jobIds: ['one'], contextRows: [], occurrenceKeys: [],
    } })).toBe(false);
    expect(isLowImpactPostingIdentityRequest({ scope: 'occurrences', apply: true, applyBatch: {
      jobIds: Array.from({ length: 101 }, (_, index) => String(index)), contextRows: [], occurrenceKeys: [],
    } })).toBe(false);
    expect(isLowImpactPostingIdentityRequest({ scope: 'occurrences', apply: true, applyBatch: {
      jobIds: ['one'], contextRows: [], occurrenceKeys: Array.from({ length: 126 }, (_, index) => [`source-${index}`, 'role']),
    } })).toBe(false);
    expect(isLowImpactPostingIdentityRequest({ scope: 'occurrences', apply: true, applyBatch: {
      jobIds: ['one'], contextRows: Array.from({ length: 126 }, () => ({})), occurrenceKeys: [],
    } })).toBe(false);
    // The catalog-wide occurrence apply no longer exists: the repair applies one
    // signed batch at a time, so a bare apply must not admit queued work.
    expect(isLowImpactPostingIdentityRequest({
      scope: 'occurrences', apply: true, finalize: false, repairToken: 'a'.repeat(64), expectedChanges: 1, expectedDuplicateJobs: 0,
    })).toBe(false);
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

describe('Cloudflare GitHub source failure health', () => {
  it('records a failed delivery against its source so the dispatch lease can be released', async () => {
    const source = defaultSources[0]!;
    const stored: SourceHealth[] = [];
    const prepare = vi.fn(() => ({
      async first() { return null; },
      bind: () => ({ async all() { return { results: [] }; }, async run() { return { meta: { changes: 1 } }; }, async first() { return null; } }),
    }));
    vi.spyOn(D1InternshipStore.prototype, 'putSourceHealth').mockImplementation(async (health) => { stored.push(health); });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider fetch unavailable in test'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = Date.now();
    const message = { id: 'github-source', body: { sourceId: source.id }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    try {
      await cloudflareWorker.queue({ queue: 'intern-notifs-github', messages: [message] }, {
        DB: { prepare, async batch() { return []; } },
        AUTH_FROM_EMAIL: 'notifications@example.test', DIGEST_TO_EMAIL: 'digest@example.test',
      } as unknown as Environment);

      const recorded = stored.filter((health) => health.provider === 'github');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ sourceId: source.id, state: 'degraded', sourceStatus: 'active', consecutiveFailures: 1 });
      expect(Date.parse(recorded[0]!.lastAttemptAt)).toBeGreaterThanOrEqual(before);
      expect(message.retry).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
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
      DB: {} as Environment['DB'], IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0.98',
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
      DB: {} as Environment['DB'], IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED: 'true', IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0.98',
    }, { audit: async () => failedPlan, log: (event) => enabledLogs.push(event) }))
      .rejects.toThrow('integrity gate failed');
    expect(enabledLogs).toHaveLength(1);
    expect(JSON.parse(enabledLogs[0]!)).toMatchObject({ status: 'failed', enforcementActive: true });
  });

  it('fails an enforced coverage regression even when the structural gate passes', async () => {
    const shadowLogs: string[] = [];
    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'], IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0.9',
    }, { audit: async () => coverageRegressionPlan, log: (event) => shadowLogs.push(event) })).resolves.toMatchObject({
      status: 'failed', enforcementActive: false, confirmedCoverage: 0.6,
      confirmedCoverageFloor: 0.9, coverageRegression: true,
    });

    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'], IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED: 'true', IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0.9',
    }, { audit: async () => coverageRegressionPlan, log: () => undefined })).rejects.toThrow('integrity gate failed');

    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'], IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED: 'true', IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0.5',
    }, { audit: async () => coverageRegressionPlan, log: () => undefined })).resolves.toMatchObject({
      status: 'passed', confirmedCoverageFloor: 0.5, coverageRegression: false,
    });
  });

  it('treats a missing or invalid coverage floor as unavailable gate evidence', async () => {
    const logs: string[] = [];
    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'],
    }, { audit: async () => coverageRegressionPlan, log: (event) => logs.push(event) })).resolves.toMatchObject({
      status: 'error', confirmedCoverageFloor: null, coverageRegression: null,
    });
    await expect(runScheduledPostingIdentityAudit({
      DB: {} as Environment['DB'], IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED: 'true', IDENTITY_CONFIRMED_COVERAGE_FLOOR: 'not-a-number',
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
  it('retries the shutdown guard query before catalog queue routing', async () => {
    const first = vi.fn()
      .mockRejectedValueOnce(new Error('D1_ERROR: Connection closed: this D1 DB instance is no longer active. Reconnect or retry the request.'))
      .mockResolvedValueOnce({ value: 'stopped' });
    const prepare = vi.fn(() => ({ bind: vi.fn(), first }));
    const message = { id: 'first', body: { sourceId: 'greenhouse-acme' }, attempts: 1,
      ack: vi.fn(), retry: vi.fn() };

    await cloudflareWorker.queue({ queue: 'intern-notifs-greenhouse', messages: [message] }, {
      DB: { prepare, async batch() { return []; } },
    } as unknown as Environment);

    expect(first).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

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

  it('defers source-scoped setup failures on the final delivery instead of dead-lettering', async () => {
    const failureRows: unknown[][] = [];
    const statements: string[] = [];
    const prepare = vi.fn((query: string) => {
      statements.push(query);
      return {
        async first() { return null; },
        bind: (...values: unknown[]) => ({
          async all() {
            if (query.includes('reviewed_source_registry')) throw new Error('D1 DB is overloaded. Requests queued for too long.');
            return { results: [] };
          },
          async run() {
            if (query.includes('INSERT INTO queue_failure_events')) failureRows.push(values);
            return { meta: { changes: 1 } };
          },
        }),
      };
    });
    const first = { id: 'first', body: { sourceId: 'greenhouse-acme' }, attempts: CATALOG_DELIVERY_MAX_ATTEMPTS,
      ack: vi.fn(), retry: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await cloudflareWorker.queue({ queue: 'intern-notifs-greenhouse', messages: [first] }, {
      DB: { prepare, async batch() { return []; } },
    } as unknown as Environment);

    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(failureRows).toHaveLength(1);
    // The deferred message is never redelivered, so the ledger row is resolved
    // here instead of inflating the unresolved count for 30 days.
    expect(statements.some((query) => query.includes('UPDATE queue_failure_events') && query.includes('resolved_at'))).toBe(true);
    vi.restoreAllMocks();
  });

  it('defers the GitHub lane when the structured registry read fails on the final delivery', async () => {
    const failureRows: unknown[][] = [];
    const statements: string[] = [];
    const prepare = vi.fn((query: string) => {
      statements.push(query);
      return {
        async first() { return null; },
        bind: (...values: unknown[]) => ({
          async all() { return { results: [] }; },
          async run() {
            if (query.includes('INSERT INTO queue_failure_events')) failureRows.push(values);
            return { meta: { changes: 1 } };
          },
        }),
      };
    });
    // The structured registry read gates every GitHub delivery, so a source-scoped
    // message that survives all attempts here is still work the dispatcher owns.
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources')
      .mockRejectedValue(new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'));
    const first = { id: 'first', body: { sourceId: defaultSources[0]!.id }, attempts: CATALOG_DELIVERY_MAX_ATTEMPTS,
      ack: vi.fn(), retry: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await cloudflareWorker.queue({ queue: 'intern-notifs-github', messages: [first] }, {
      DB: { prepare, async batch() { return []; } },
    } as unknown as Environment);

    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(failureRows).toHaveLength(1);
    expect(statements.some((query) => query.includes('UPDATE queue_failure_events') && query.includes('resolved_at'))).toBe(true);
    vi.restoreAllMocks();
  });

  it('still retries a GitHub setup failure the dispatcher cannot re-own', async () => {
    const prepare = vi.fn(() => ({
      async first() { return null; },
      bind: () => ({
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
      }),
    }));
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources')
      .mockRejectedValue(new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'));
    // A body without a source ID names no work the dispatcher could re-issue, so
    // it stays on the retry path even on the final delivery.
    const first = { id: 'first', body: 'not-json', attempts: CATALOG_DELIVERY_MAX_ATTEMPTS,
      ack: vi.fn(), retry: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await cloudflareWorker.queue({ queue: 'intern-notifs-github', messages: [first] }, {
      DB: { prepare, async batch() { return []; } },
    } as unknown as Environment);

    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('still retries a forced GitHub recovery the dispatcher cannot re-issue', async () => {
    const prepare = vi.fn(() => ({
      async first() { return null; },
      bind: () => ({
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
      }),
    }));
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources')
      .mockRejectedValue(new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'));
    // The scheduled GitHub dispatch skips quarantined sources and the lane has
    // no recovery probe, so a forced recovery is the only message that would
    // re-issue one: it must dead-letter instead of being acked into silence.
    const first = { id: 'first', body: { sourceId: defaultSources[0]!.id, force: true },
      attempts: CATALOG_DELIVERY_MAX_ATTEMPTS, ack: vi.fn(), retry: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await cloudflareWorker.queue({ queue: 'intern-notifs-github', messages: [first] }, {
      DB: { prepare, async batch() { return []; } },
    } as unknown as Environment);

    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('Cloudflare DNS resolver queries', () => {
  it('bounds every DoH query with a timeout signal', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const endpoints: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      endpoints.push(String(url));
      signals.push(init?.signal ?? undefined);
      return new Response(JSON.stringify({ Answer: [{ type: 1, data: '203.0.113.10' }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(dnsJson('boards.example.test', 'A')).resolves.toEqual([{ type: 1, data: '203.0.113.10' }]);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(endpoints[0]).toContain('type=A');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps only the requested record type so a CNAME target is never an address', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ Answer: [
      { type: 5, data: 'boards.us.example.test.' },
      { type: 1, data: '13.32.241.9' },
      { type: 1, data: '13.32.241.121' },
    ] }), { status: 200 })) as typeof fetch;
    try {
      // `assertPublicHttpsUrl` rejects any answer that is not a public IP, so a
      // CNAME target hostname must never reach its address list.
      await expect(dnsJson('boards-api.example.test', 'A')).resolves.toEqual([{ type: 1, data: '13.32.241.9' }, { type: 1, data: '13.32.241.121' }]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('fails a stalled DoH query instead of waiting for it', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('The operation was aborted due to timeout'); }) as typeof fetch;
    try {
      await expect(dnsJson('boards.example.test', 'AAAA'))
        .rejects.toThrow('DNS verification timed out for boards.example.test (AAAA)');
    } finally {
      globalThis.fetch = original;
    }
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
      GREENHOUSE_QUEUE: queue(async () => ({ backlogCount: 7, backlogBytes: 700, oldestMessageTimestamp: new Date('2026-09-15T16:02:15.922Z') })),
      LEVER_QUEUE: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      ASHBY_QUEUE: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      GITHUB_QUEUE: queue(async () => ({ backlogCount: 3, backlogBytes: 300 })),
      GREENHOUSE_DLQ: queue(async () => ({ backlogCount: 2, backlogBytes: 200 })),
      LEVER_DLQ: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      ASHBY_DLQ: queue(async () => ({ backlogCount: 0, backlogBytes: 0 })),
      GITHUB_DLQ: queue(async () => ({ backlogCount: 1, backlogBytes: 100 })),
    });

    await expect(client.send({ input: { QueueUrl: integrationRegistry.greenhouse.queues.work } })).resolves.toMatchObject({
      Attributes: { ApproximateNumberOfMessages: '7', oldest_message_timestamp_ms: '1789488135922' },
    });
    await expect(client.send({ input: { QueueUrl: integrationRegistry.greenhouse.queues.work } })).resolves.not.toMatchObject({
      Attributes: { ApproximateNumberOfMessagesNotVisible: expect.anything() },
    });
    await expect(client.send({ input: { QueueUrl: integrationRegistry.greenhouse.queues.deadLetter } })).resolves.toMatchObject({
      Attributes: { ApproximateNumberOfMessages: '2' },
    });
    await expect(client.send({ input: { QueueUrl: integrationRegistry.greenhouse.queues.deadLetter } })).resolves.not.toMatchObject({
      Attributes: { oldest_message_timestamp_ms: expect.anything() },
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

describe('Cloudflare GitHub queue continuation', () => {
  const reviewedGithub = defaultSources[0]!;

  /**
   * Deliver one GitHub message whose runtime poll reports `report`. The reviewed
   * structured registry is empty, so the delivery reaches the reviewed GitHub
   * branch, and the source reports no prior health so quarantine cannot block it.
   */
  const deliver = async (report: Record<string, unknown>, options: { force?: boolean; priorHealth?: SourceHealth; sendError?: Error; attempts?: number; pollError?: Error; expectNoPoll?: boolean } = {}) => {
    const sent: unknown[] = [];
    const handled: string[] = [];
    const statements: string[] = [];
    const polls: Array<{ command: string; sourceIds: string[]; maxListingsPerSourceRun: number | undefined }> = [];
    const workQueue: Queue = {
      async send(message) {
        if (options.sendError) throw options.sendError;
        sent.push(message);
      },
      async sendBatch() {},
    };
    const logged: string[] = [];
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources').mockResolvedValue([]);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue(options.priorHealth);
    runtime.runRuntimeCommand.mockImplementationOnce(async (command, dependencies) => {
      polls.push({
        command,
        sourceIds: (dependencies.sources ?? []).map((source) => source.id),
        maxListingsPerSourceRun: dependencies.maxListingsPerSourceRun,
      });
      if (options.pollError) throw options.pollError;
      return { poll: report };
    });
    vi.spyOn(console, 'log').mockImplementation((line) => { logged.push(String(line)); });
    const message = {
      id: 'github-first', body: { sourceId: reviewedGithub.id, ...(options.force ? { force: true } : {}) }, attempts: options.attempts ?? 1,
      ack() { handled.push('ack'); }, retry() { handled.push('retry'); },
    };
    try {
      await cloudflareWorker.queue({ queue: 'intern-notifs-github', messages: [message] }, {
        // The health and failure-ledger writes run on the real path, so the fake
        // DB supports `bind`; without it they threw and the ledger assertions
        // could never observe a write.
        DB: {
          prepare: (query: string) => {
            statements.push(query);
            return {
              async first() { return null; },
              bind: () => ({
                async all() { return { results: [] }; },
                async run() { return { meta: { changes: 1 } }; },
              }),
            };
          },
          async batch() { return []; },
        },
        GITHUB_QUEUE: workQueue,
      } as unknown as Environment);
    } finally {
      vi.restoreAllMocks();
    }
    // One bounded poll slice per delivery is the delivery's whole reason to
    // re-enqueue itself, so every case pins the poll it issued. A blocked source
    // is skipped before the poll, so it asserts the opposite.
    if (options.expectNoPoll) expect(polls).toEqual([]);
    else expect(polls).toEqual([{
      command: 'poll', sourceIds: [reviewedGithub.id],
      maxListingsPerSourceRun: GITHUB_RESOLUTION_ROWS_PER_DELIVERY,
    }]);
    const sliceEvents = logged.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.event === 'github_admission_migration_slice');
    return { sent, handled, statements, sliceEvents };
  };

  it('re-enqueues the source once and acks while the delivery leaves a pending resolution slice', async () => {
    const { sent, handled, sliceEvents } = await deliver({
      continuationSources: [reviewedGithub.id],
      pendingResolution: { [reviewedGithub.id]: 4 },
      failures: [],
    });

    expect(sent).toEqual([{ sourceId: reviewedGithub.id }]);
    expect(sliceEvents).toEqual([expect.objectContaining({
      sourceId: reviewedGithub.id, continuation: true, resolutionPending: 4, failureCount: 0,
    })]);
    expect(handled).toEqual(['ack']);
  });

  it('acks a committed slice when its continuation send fails for the scheduled dispatcher to resume', async () => {
    const { sent, handled, sliceEvents } = await deliver({
      continuationSources: [reviewedGithub.id], pendingResolution: { [reviewedGithub.id]: 4 }, failures: [],
    }, { sendError: new Error('Queue send timed out') });

    expect(sent).toEqual([]);
    expect(handled).toEqual(['ack']);
    expect(sliceEvents).toEqual([expect.objectContaining({ resolutionPending: 4, failureCount: 0 })]);
  });

  it('defers a source failure that survives every delivery instead of dead-lettering it', async () => {
    const { sent, handled, statements } = await deliver({}, {
      attempts: CATALOG_DELIVERY_MAX_ATTEMPTS,
      pollError: new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'),
    });

    expect(sent).toEqual([]);
    expect(handled).toEqual(['ack']);
    // A deferred message is acked and never redelivered, so its failure row is
    // resolved here instead of inflating the unresolved count.
    expect(statements.some((query) => query.includes('UPDATE queue_failure_events') && query.includes('resolved_at'))).toBe(true);
  });

  it('resolves an earlier failure row when a blocked source is acked', async () => {
    const { handled, statements } = await deliver({}, {
      attempts: 2,
      expectNoPoll: true,
      priorHealth: {
        sourceId: reviewedGithub.id, state: 'quarantined', sourceStatus: 'paused',
        lastAttemptAt: '2026-08-26T12:00:00.000Z', consecutiveFailures: 2, durationMs: 4,
      },
    });

    // The blocked source runs no poll, so the delivery is acked; its earlier
    // failed attempt's row must still be resolved rather than lingering.
    expect(handled).toEqual(['ack']);
    expect(statements.some((query) => query.includes('UPDATE queue_failure_events') && query.includes('resolved_at'))).toBe(true);
  });

  it('retries a source failure before the final delivery', async () => {
    const { handled } = await deliver({}, {
      attempts: CATALOG_DELIVERY_MAX_ATTEMPTS - 1,
      pollError: new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'),
    });

    expect(handled).toEqual(['retry']);
  });

  it('still returns a message the dispatcher cannot re-own to the platform', async () => {
    const { handled } = await deliver({}, {
      attempts: CATALOG_DELIVERY_MAX_ATTEMPTS,
      pollError: new Error('Unknown reviewed source "ghost"'),
    });

    expect(handled).toEqual(['retry']);
  });

  it('keeps a forced recovery on the retry path so a failed recovery dead-letters', async () => {
    const { handled } = await deliver({}, {
      force: true,
      attempts: CATALOG_DELIVERY_MAX_ATTEMPTS,
      pollError: new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'),
    });

    // The scheduled GitHub dispatch skips quarantined sources and the lane has
    // no recovery probe, so a forced recovery is the only message that would
    // re-issue one. It must dead-letter instead of being acked into silence.
    expect(handled).toEqual(['retry']);
  });

  it('keeps forced recovery on every continuation while the source remains paused', async () => {
    const { sent, handled } = await deliver({
      continuationSources: [reviewedGithub.id],
      pendingResolution: { [reviewedGithub.id]: 4 },
      failures: [],
    }, {
      force: true,
      priorHealth: { sourceId: reviewedGithub.id, provider: 'github', region: 'unknown', state: 'quarantined',
        sourceStatus: 'paused', consecutiveFailures: 2, lastAttemptAt: '2026-09-20T18:12:45.125Z', durationMs: 1 },
    });

    expect(sent).toEqual([{ sourceId: reviewedGithub.id, force: true }]);
    expect(handled).toEqual(['ack']);
  });

  it('acks a delivery that resolved its whole slice without re-enqueueing it', async () => {
    const { sent, handled, sliceEvents } = await deliver({ continuationSources: [], pendingResolution: {}, failures: [] });

    expect(sent).toEqual([]);
    expect(sliceEvents).toEqual([]);
    expect(handled).toEqual(['ack']);
  });

  it('observes a real GitHub delivery through the controller without changing its acknowledgement', async () => {
    const controllerFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ permit: { permitId: 'permit-1', expiresAt: '2026-09-17T00:00:30.000Z', fenced: true }, status: { mode: 'observation', permitsInUse: { P0: 1, P1: 0, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 } }))
      .mockResolvedValueOnce(Response.json({ mode: 'observation', permitsInUse: { P0: 0, P1: 0, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 }));
    const ack = vi.fn();
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources').mockResolvedValue([]);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue(undefined);
    runtime.runRuntimeCommand.mockResolvedValueOnce({ poll: { continuationSources: [], pendingResolution: {}, failures: [] } });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await cloudflareWorker.queue({ queue: 'intern-notifs-github', messages: [{
        id: 'github-observed', body: { sourceId: reviewedGithub.id }, attempts: 1, ack, retry: vi.fn(),
      }] }, {
        DB: { prepare: () => ({ async first() { return null; } }), async batch() { return []; } },
        GITHUB_QUEUE: { async send() {}, async sendBatch() {} },
        D1_TRAFFIC_CONTROLLER: { idFromName: vi.fn(() => 'catalog-ingestion'), get: vi.fn(() => ({ fetch: controllerFetch })) },
      } as unknown as Environment);

      expect(ack).toHaveBeenCalledOnce();
      expect(controllerFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(controllerFetch.mock.calls[0]![1]?.body))).toMatchObject({
        workload: 'catalog:github', priority: 'P0', messageId: 'github-observed', runId: 'intern-notifs-github',
      });
      expect(JSON.parse(String(controllerFetch.mock.calls[1]![1]?.body))).toMatchObject({ permitId: 'permit-1', outcome: 'success' });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('releases an observation permit when a GitHub source is skipped', async () => {
    const controllerFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ permit: { permitId: 'permit-skipped', expiresAt: '2026-09-17T00:00:30.000Z', fenced: true }, status: { mode: 'observation', permitsInUse: { P0: 1, P1: 0, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 } }))
      .mockResolvedValueOnce(Response.json({ mode: 'observation', permitsInUse: { P0: 0, P1: 0, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 }));
    const ack = vi.fn();
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources').mockResolvedValue([]);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue({
      sourceId: reviewedGithub.id, state: 'quarantined', sourceStatus: 'paused', lastAttemptAt: '2026-09-17T00:00:00.000Z', consecutiveFailures: 1, durationMs: 1,
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await cloudflareWorker.queue({ queue: 'intern-notifs-github', messages: [{
        id: 'github-skipped', body: { sourceId: reviewedGithub.id }, attempts: 1, ack, retry: vi.fn(),
      }] }, {
        DB: { prepare: () => ({ async first() { return null; } }), async batch() { return []; } },
        GITHUB_QUEUE: { async send() {}, async sendBatch() {} },
        D1_TRAFFIC_CONTROLLER: { idFromName: vi.fn(() => 'catalog-ingestion'), get: vi.fn(() => ({ fetch: controllerFetch })) },
      } as unknown as Environment);

      expect(ack).toHaveBeenCalledOnce();
      expect(controllerFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(controllerFetch.mock.calls[1]![1]?.body))).toMatchObject({ permitId: 'permit-skipped', outcome: 'cancelled' });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('cancels an observation permit when a structured source is blocked', async () => {
    const controllerFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ permit: { permitId: 'permit-structured', expiresAt: '2026-09-17T00:00:30.000Z', fenced: true }, status: { mode: 'observation', permitsInUse: { P0: 1, P1: 0, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 } }))
      .mockResolvedValueOnce(Response.json({ mode: 'observation', permitsInUse: { P0: 0, P1: 0, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 }));
    const ack = vi.fn();
    vi.spyOn(D1EmployerStore.prototype, 'listReviewedSources').mockResolvedValue([{
      sourceId: 'structured-blocked', provider: 'json-ld', state: 'active',
      config: { id: 'structured-blocked', url: 'https://careers.example.test/jobs', employer: { name: 'Example' }, allowedApplicationHosts: [{ host: 'careers.example.test' }] },
      evidence: {}, createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
    }]);
    vi.spyOn(D1InternshipStore.prototype, 'getSourceHealth').mockResolvedValue({
      sourceId: 'structured-blocked', state: 'quarantined', sourceStatus: 'paused', lastAttemptAt: '2026-09-17T00:00:00.000Z', consecutiveFailures: 1, durationMs: 1,
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await cloudflareWorker.queue({ queue: 'intern-notifs-github', messages: [{
        id: 'structured-blocked', body: { sourceId: 'structured-blocked', sourceKind: 'structured' }, attempts: 1, ack, retry: vi.fn(),
      }] }, {
        DB: { prepare: () => ({ async first() { return null; } }), async batch() { return []; } },
        GITHUB_QUEUE: { async send() {}, async sendBatch() {} },
        D1_TRAFFIC_CONTROLLER: { idFromName: vi.fn(() => 'catalog-ingestion'), get: vi.fn(() => ({ fetch: controllerFetch })) },
      } as unknown as Environment);

      expect(ack).toHaveBeenCalledOnce();
      expect(controllerFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(controllerFetch.mock.calls[1]![1]?.body))).toMatchObject({ permitId: 'permit-structured', outcome: 'cancelled' });
      expect(runtime.runRuntimeCommand).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('Cloudflare D1 traffic observation', () => {
  it('observes a destination-verification retry and its D1 failure class without taking the retry decision', async () => {
    const controllerFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ permit: { permitId: 'permit-destination', expiresAt: '2026-09-21T00:00:30.000Z', fenced: true }, status: { mode: 'observation', permitsInUse: { P0: 0, P1: 1, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 } }))
      .mockResolvedValueOnce(Response.json({ mode: 'observation', permitsInUse: { P0: 0, P1: 0, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 }));
    const ack = vi.fn();
    const retry = vi.fn();
    const d1Failure = new Error('D1_ERROR: internal error; reference = test');
    // The shutdown latch reads system_state; every other statement is the D1
    // failure the consumer retries.
    const failingStatement = (query: string): D1PreparedStatement => ({
      bind: () => failingStatement(query),
      first: async () => { if (query.includes('system_state')) return null; throw d1Failure; },
      all: async () => { throw d1Failure; },
      run: async () => { throw d1Failure; },
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await cloudflareWorker.queue({
        queue: 'intern-notifs-destination-verification',
        messages: [{
          id: 'destination-1', attempts: 1, ack, retry,
          body: { version: 1, jobId: 'job-1', sourceId: 'greenhouse-1', externalId: '1',
            candidateUrl: 'https://example.test/job', providerIdentity: {} },
        }],
      }, {
        DB: { prepare: failingStatement, async batch() { return []; } },
        D1_TRAFFIC_CONTROLLER: { idFromName: vi.fn(() => 'catalog-ingestion'), get: vi.fn(() => ({ fetch: controllerFetch })) },
      } as unknown as Environment);

      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledWith({ delaySeconds: 300 });
      expect(controllerFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(controllerFetch.mock.calls[0]![1]?.body))).toMatchObject({
        workload: 'destination-verification', priority: 'P1', messageId: 'destination-1', runId: 'intern-notifs-destination-verification',
      });
      expect(JSON.parse(String(controllerFetch.mock.calls[1]![1]?.body))).toMatchObject({
        permitId: 'permit-destination', outcome: 'failure', d1FailureClass: 'internal',
      });
    } finally {
      vi.restoreAllMocks();
    }
  });
});
