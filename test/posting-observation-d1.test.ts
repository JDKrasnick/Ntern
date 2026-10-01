import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { buildPostingIdentity } from '../src/identity/posting.js';
import type { CatalogAdmission, Internship, PostingIdentityDecision, SourceOccurrenceState } from '../src/types.js';

function sqliteD1(database: DatabaseSync, failBatchAfter?: number, onQuery?: (method: 'first' | 'all', query: string) => void): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { onQuery?.('first', query); return (database.prepare(query).get(...values) as T | undefined) ?? null; },
    async all<T>() { onQuery?.('all', query); return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { const result = database.prepare(query).run(...values); return { meta: { changes: Number(result.changes) } }; },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const results = [];
        for (let index = 0; index < statements.length; index += 1) {
          if (failBatchAfter !== undefined && index === failBatchAfter) throw new Error('injected observation failure');
          results.push(await statements[index]!.run());
        }
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function subject(failBatchAfter?: number, onQuery?: (method: 'first' | 'all', query: string) => void) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0010_posting_identity.sql', import.meta.url), 'utf8'));
  return { sqlite, store: new D1InternshipStore(sqliteD1(sqlite, failBatchAfter, onQuery)) };
}

function input() {
  const observedAt = '2026-08-29T12:00:00.000Z';
  const identity = buildPostingIdentity({ applicationUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  const decision: Exclude<PostingIdentityDecision, { status: 'quarantined' }> = {
    status: 'confirmed', exactKey: `provider:ashby:acme:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
    evidenceKind: 'immutable-provider-id', provider: 'ashby', tenant: 'acme', contractId: 'posting-provider-ashby',
    contractVersion: 1, approvalReference: 'registry:ashby:v1', evidenceHash: 'hash', observedAt,
  };
  const source = {
    sourceId: 'community', externalId: 'role-a', document: 'README', sourceUrl: 'https://source.example.test', row: 1,
    company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
    applyUrl: identity.canonicalApplicationUrl, compensation: { raw: '' }, state: 'open' as const,
    postingIdentityDecision: decision,
  };
  const job: Internship = {
    jobId: identity.canonicalJobId, company: source.company, title: source.title, location: source.location, season: source.season,
    applyUrl: source.applyUrl, normalizedUrl: source.applyUrl, fingerprint: 'fingerprint', compensation: source.compensation,
    sourceReferences: [source], postingIdentity: identity, postingIdentityStatus: 'confirmed', technical: true, open: true,
    firstSeenAt: observedAt, catalogVisibleAt: observedAt, lastSeenAt: observedAt, notification: { smsPending: true, digestPending: true },
  };
  const occurrence: SourceOccurrenceState = {
    sourceId: source.sourceId, externalId: source.externalId, jobId: job.jobId, occurrence: source,
    present: true, consecutiveOmissions: 0, changedSnapshotHash: 'snapshot', changedAt: observedAt,
  };
  return { decision, identity, job, occurrence, notificationEvent: {
    eventId: 'event-a', sourceId: source.sourceId, externalId: source.externalId, jobId: job.jobId,
    kind: 'new-job' as const, createdAt: observedAt,
  } };
}

function admission(evaluatedAt: string, browserVisible?: boolean): CatalogAdmission {
  return {
    employerResolution: 'resolved', postingAttribution: 'attributed',
    destination: {
      classification: 'application-form', candidateUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/application',
      provider: 'ashby', tenant: 'acme', expectedPostingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      inspectedAt: evaluatedAt, ...(browserVisible === undefined ? {} : { browserVisible }),
    },
    metadata: { complete: true, title: 'complete', location: 'complete' },
    catalogEligible: true, alertEligible: true, reasonCodes: [], evaluatedAt, evidenceObservedAt: evaluatedAt,
  };
}

function withOfficialEmployerConflict(base: Internship): Internship {
  const officialAdmission = (id: string): CatalogAdmission => ({
    ...admission('2026-08-29T12:00:00.000Z'), canonicalEmployer: { id, displayName: id },
  });
  const reference = base.sourceReferences[0]!;
  return {
    ...base,
    sourceReferences: [
      { ...reference, sourceId: 'official-a', externalId: 'official-a', provenance: 'official-ats', admission: officialAdmission('employer-a') },
      { ...reference, sourceId: 'official-b', externalId: 'official-b', provenance: 'official-structured', admission: officialAdmission('employer-b') },
    ],
    admission: {
      ...admission('2026-08-29T12:00:00.000Z'), canonicalEmployer: undefined, employerResolution: 'conflict',
      catalogEligible: false, alertEligible: false, reasonCodes: ['employer-conflict'],
    },
    notification: { smsPending: false, digestPending: false },
  };
}

describe('D1 atomic posting observation', () => {
  it('writes the complete observation in one D1 transaction', async () => {
    const { sqlite, store } = subject();
    await expect(store.commitPostingObservation(input())).resolves.toMatchObject({ outcome: 'committed', notificationInserted: true });
    expect(sqlite.prepare("SELECT kind, count(*) AS count FROM catalog_items GROUP BY kind ORDER BY kind").all()).toEqual(expect.arrayContaining([
      { kind: 'internship', count: 1 }, { kind: 'notification-event', count: 1 },
      { kind: 'source-occurrence', count: 1 },
    ]));
    expect(sqlite.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'posting-alias'").get()).toMatchObject({ count: expect.any(Number) });
  });

  it('atomically records and drains a provider shadow verification outbox item', async () => {
    const { store } = subject(); const observation = input();
    const providerShadowVerification = { jobId: observation.job.jobId, sourceId: observation.occurrence.sourceId,
      externalId: observation.occurrence.externalId, providerIdentity: { provider: 'ashby' as const,
        sourceId: observation.occurrence.sourceId, sourceUrl: observation.occurrence.occurrence.sourceUrl,
        tenant: 'acme', postingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, candidateUrl: observation.job.applyUrl,
      reason: 'first-sight' as const, idempotencyKey: 'provider-shadow-revision-a', metadataExtractionVersion: 4,
      shadowOrigin: 'provider-poll' as const };
    await store.commitPostingObservation({ ...observation, providerShadowVerification });
    await expect(store.listPendingProviderShadowVerifications()).resolves.toEqual([providerShadowVerification]);
    await store.markProviderShadowVerificationEnqueued(providerShadowVerification.idempotencyKey);
    await expect(store.listPendingProviderShadowVerifications()).resolves.toEqual([]);
  });

  it('loads the current job and occurrence in one D1 request', async () => {
    let stateReads = 0;
    const { store } = subject(undefined, (method, query) => {
      if (method === 'all' && query.includes('SELECT pk, sk, value FROM catalog_items')) stateReads += 1;
    });
    await store.commitPostingObservation(input());
    expect(stateReads).toBe(1);
  });

  it('does not erase newer browser admission when a stale observation wins the write race', async () => {
    const { store } = subject();
    const original = input();
    await store.commitPostingObservation(original);

    const verifiedAt = '2026-08-29T12:00:47.000Z';
    const browserAdmission = admission(verifiedAt, true);
    const stored = await store.getJob(original.job.jobId);
    const storedOccurrence = (await store.getSourceOccurrences(original.occurrence.sourceId))[0];
    expect(stored).toBeDefined();
    expect(storedOccurrence).toBeDefined();
    await store.putAdmissionState({
      ...stored!, sourceReferences: [{ ...stored!.sourceReferences[0]!, admission: browserAdmission }],
    }, stored!.sourceReferences[0]!, {
      ...storedOccurrence!, occurrence: { ...storedOccurrence!.occurrence, admission: browserAdmission },
    }, storedOccurrence!);

    const staleAdmission = admission('2026-08-29T12:00:28.000Z');
    await store.commitPostingObservation({
      ...original,
      job: { ...original.job, sourceReferences: [{ ...original.job.sourceReferences[0]!, admission: staleAdmission }] },
      occurrence: {
        ...original.occurrence,
        occurrence: { ...original.occurrence.occurrence, admission: staleAdmission },
      },
      notificationEvent: undefined,
    });

    const projected = await store.getJob(original.job.jobId);
    const projectedOccurrence = (await store.getSourceOccurrences(original.occurrence.sourceId))[0];
    expect(projected?.sourceReferences[0]?.admission).toEqual(browserAdmission);
    expect(projectedOccurrence?.occurrence.admission).toEqual(browserAdmission);
  });

  it('does not persist a stale promotion when the committed projection has an employer conflict', async () => {
    const { sqlite, store } = subject();
    const stalePromotion = input();
    await store.putInternship(withOfficialEmployerConflict(stalePromotion.job));

    await expect(store.commitPostingObservation(stalePromotion)).resolves.toMatchObject({
      outcome: 'committed', notificationInserted: false,
    });

    expect(await store.getJob(stalePromotion.job.jobId)).toMatchObject({
      admission: { employerResolution: 'conflict', catalogEligible: false, alertEligible: false },
      notification: { smsPending: false, digestPending: false },
    });
    expect(sqlite.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get())
      .toEqual({ count: 0 });
  });

  it('rolls back every public write when a failure is injected mid-commit', async () => {
    const { sqlite, store } = subject(1);
    await expect(store.commitPostingObservation(input())).rejects.toThrow('injected observation failure');
    expect(sqlite.prepare('SELECT count(*) AS count FROM catalog_items').get()).toEqual({ count: 0 });
  });

  it('queues an identity-unconfirmed URL family without retaining URL values', async () => {
    const { sqlite, store } = subject();
    const original = input();
    const decision = {
      status: 'unconfirmed' as const,
      reason: 'unrecognized-url-family' as const,
      reviewFamilyKey: 'careers.example.test/jobs/:number?ref',
      observedAt: '2026-08-29T12:00:00.000Z',
    };
    await store.commitPostingObservation({
      decision,
      job: { ...original.job, postingIdentity: undefined, postingIdentityStatus: 'unconfirmed' },
      occurrence: {
        ...original.occurrence,
        occurrence: { ...original.occurrence.occurrence, postingIdentityDecision: decision },
      },
      notificationEvent: original.notificationEvent,
    });
    expect(sqlite.prepare('SELECT sanitized_signature, occurrence_count FROM posting_identity_review_candidates').get())
      .toEqual({ sanitized_signature: decision.reviewFamilyKey, occurrence_count: 1 });
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM posting_identity_review_candidates').all()))
      .not.toContain('utm_');
  });

  it('quarantines a new exact ID when a preferred D1 job already owns another one', async () => {
    const { sqlite, store } = subject();
    const first = input();
    await store.commitPostingObservation(first);
    const identity = buildPostingIdentity({ applicationUrl: 'https://jobs.ashbyhq.com/acme/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
    const decision = {
      ...first.decision,
      exactKey: 'provider:ashby:acme:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      evidenceHash: 'second-hash',
    };
    const occurrence = {
      ...first.occurrence,
      externalId: 'role-b',
      occurrence: {
        ...first.occurrence.occurrence,
        externalId: 'role-b',
        applyUrl: identity.canonicalApplicationUrl,
        postingIdentityDecision: decision,
      },
    };
    await expect(store.commitPostingObservation({
      decision, identity,
      job: { ...first.job, postingIdentity: identity, sourceReferences: [occurrence.occurrence] },
      occurrence,
    })).resolves.toMatchObject({ outcome: 'quarantined' });
    expect(sqlite.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'internship'").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'posting-identity-incident'").get()).toEqual({ count: 1 });
  });

  it('deduplicates a recurring identity conflict across observation times', async () => {
    const { sqlite, store } = subject();
    const occurrence = input().occurrence.occurrence;
    const decision = {
      status: 'quarantined' as const,
      reason: 'aliases-resolve-to-different-jobs' as const,
      contradictoryEvidence: ['job-b', 'job-a'],
      reviewFamilyKey: 'jobs.example.test/jobs/:segment?',
      observedAt: '2026-09-30T00:00:00.000Z',
    };
    await store.commitPostingObservation({ decision, sourceId: 'community', externalId: 'role-a', occurrence });
    await store.commitPostingObservation({
      decision: { ...decision, contradictoryEvidence: ['job-a', 'job-b'], observedAt: '2026-10-01T00:00:00.000Z' },
      sourceId: 'community', externalId: 'role-a', occurrence: { ...occurrence, row: 2 },
    });

    expect(sqlite.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'posting-identity-incident'").get())
      .toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT pk, json_extract(value, '$.recordedAt') AS recorded_at FROM catalog_items WHERE kind = 'posting-identity-incident'").get())
      .toMatchObject({ pk: expect.stringMatching(/^IDENTITY_INCIDENT_V2#/u), recorded_at: decision.observedAt });
  });

  it('makes reviewer decisions immutable', () => {
    const { sqlite } = subject();
    sqlite.prepare("INSERT INTO posting_identity_review_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('candidate', 'family', 'family', 2, 'hash', '2026-08-01', '2026-08-02', 'approved');
    sqlite.prepare("INSERT INTO posting_identity_review_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('decision', 'candidate', 'approved', 'contract', 1, 'hash', 'reviewer', '2026-08-02');
    expect(() => sqlite.prepare("UPDATE posting_identity_review_decisions SET reviewed_by = 'other' WHERE id = 'decision'").run())
      .toThrow(/immutable/u);
  });
});
