import { describe, expect, it } from 'vitest';
import { ReconcilerAdmissionV2CatalogSink } from '../src/ingestion-v2/admission/catalog-sink.js';
import { stableSourceOccurrenceJobId } from '../src/identity/registry.js';
import { MemoryInternshipStore } from '../src/store.js';
import { processPosting } from '../src/ingestion/processor.js';
import { catalogPublishable } from '../src/catalog-live.js';
import { resolvePostingIdentityDecision } from '../src/identity/registry.js';
import type { AdmissionCatalogCommit } from '../src/ingestion-v2/admission/evaluator.js';
import type { CatalogAdmission, ProcessedListing } from '../src/types.js';

const observedAt = '2026-10-03T12:00:00.000Z';
const sourceId = 'community-example';
const externalId = 'role-1';

function admission(): CatalogAdmission {
  return {
    canonicalEmployer: { id: 'acme', displayName: 'Acme' },
    employerResolution: 'resolved',
    postingAttribution: 'attributed',
    destination: {
      classification: 'application-form',
      candidateUrl: 'https://jobs.example.com/role-1/apply',
      provider: 'unknown',
      inspectedAt: observedAt,
      closureState: 'open',
      freshUntil: '2026-10-10T12:00:00.000Z',
      nextCheckAt: '2026-10-09T12:00:00.000Z',
    },
    metadata: { complete: true, title: 'complete', location: 'complete' },
    catalogEligible: true,
    alertEligible: true,
    reasonCodes: [],
    evaluatedAt: observedAt,
    evidenceObservedAt: observedAt,
  };
}

function listing(): ProcessedListing {
  return {
    sourceId,
    externalId,
    document: 'board',
    sourceUrl: 'https://example.com/board',
    row: 1,
    company: 'Acme',
    title: 'Software Engineering Intern',
    location: 'Remote',
    locations: ['Remote'],
    season: 'summer-2027',
    applyUrl: 'https://jobs.example.com/role-1/apply',
    compensation: { raw: '' },
    requirements: { requiresUsCitizenship: false, advancedDegreeRequired: false },
    state: 'open',
    fetchedAt: observedAt,
    technical: true,
    postingIdentityDecision: {
      status: 'unconfirmed',
      reason: 'unrecognized-url-family',
      reviewFamilyKey: 'jobs.example.com/role-1',
      observedAt,
    },
  };
}

function commit(overrides: Partial<AdmissionCatalogCommit> = {}): AdmissionCatalogCommit {
  return {
    sourceId,
    externalId,
    baseline: false,
    admissionVersion: 'standard-v1',
    listing: listing(),
    admission: admission(),
    jobId: stableSourceOccurrenceJobId(sourceId, externalId),
    notify: true,
    ...overrides,
  };
}

function officialCommit(): AdmissionCatalogCommit {
  const sourceId = 'lever-acme';
  const externalId = '95e0d2b0-437a-4096-a5c6-0f247f426c90';
  const applyUrl = `https://jobs.lever.co/acme/${externalId}/apply`;
  const resolved = resolvePostingIdentityDecision({ sourceId, externalId, applicationUrl: applyUrl, observedAt });
  return commit({ sourceId, externalId, jobId: resolved.identity!.canonicalJobId,
    listing: { ...listing(), sourceId, externalId, applyUrl,
      postingIdentityDecision: resolved.decision, postingIdentity: resolved.identity,
      providerIdentity: { provider: 'lever', sourceId, sourceUrl: 'https://api.lever.co/v0/postings/acme', tenant: 'acme', postingId: externalId },
      shadowContentHash: 'a'.repeat(64) }, baseline: true, notify: false });
}

describe('ingestion v2 reconciler catalog sink', () => {
  it('atomically hands fresh and changed official postings to shadow metadata extraction, with duplicate silence', async () => {
    const store = new MemoryInternshipStore();
    const sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(observedAt));
    const input = officialCommit();
    const incoming = input.listing;
    expect(incoming.postingIdentityDecision?.status).toBe('confirmed');
    await sink.commit(input);
    const [first] = await store.listPendingProviderShadowVerifications();
    expect(first).toMatchObject({ sourceId: input.sourceId, externalId: input.externalId, reason: 'first-sight', shadowOrigin: 'provider-poll', shadowContentHash: incoming.shadowContentHash });
    await store.markProviderShadowVerificationEnqueued(first.idempotencyKey!);
    await sink.commit(input);
    expect(await store.listPendingProviderShadowVerifications()).toEqual([]);
    await sink.commit({ ...input, listing: { ...incoming, shadowContentHash: 'b'.repeat(64) } });
    expect(await store.listPendingProviderShadowVerifications()).toEqual([expect.objectContaining({
      reason: 'content-change', shadowContentHash: 'b'.repeat(64),
    })]);
    expect(store.notificationEvents.size).toBe(0);
  });
  it.each([
    ['nontechnical', { technical: false }],
    ['closed', { state: 'closed' as const }],
    ['missing content hash', { shadowContentHash: undefined }],
    ['unconfirmed identity', { postingIdentity: undefined, postingIdentityDecision: listing().postingIdentityDecision }],
    ['unsupported provider', { providerIdentity: undefined }],
  ])('does not request paid shadow extraction for %s postings', async (_reason, patch) => {
    const store = new MemoryInternshipStore();
    const sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(observedAt));
    const input = officialCommit();
    await sink.commit({ ...input, listing: { ...input.listing, ...patch } });
    expect(await store.listPendingProviderShadowVerifications()).toEqual([]);
  });

  it('does not request extraction for ineligible admission or unchanged historical adoption', async () => {
    const store = new MemoryInternshipStore();
    const sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(observedAt));
    const input = officialCommit();
    await sink.commit({ ...input, admission: { ...input.admission, catalogEligible: false } });
    expect(await store.listPendingProviderShadowVerifications()).toEqual([]);
    await sink.commit(input);
    expect(await store.listPendingProviderShadowVerifications()).toEqual([]);
  });

  it('retains one durable extraction handoff after an ambiguous successful commit', async () => {
    class FailAfterCommit extends MemoryInternshipStore {
      failed = false;
      override async commitPostingObservation(input: Parameters<MemoryInternshipStore['commitPostingObservation']>[0]) {
        const result = await super.commitPostingObservation(input);
        if (!this.failed) { this.failed = true; throw new Error('lost commit response'); }
        return result;
      }
    }
    const store = new FailAfterCommit();
    const sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(observedAt));
    const input = officialCommit();
    await expect(sink.commit(input)).rejects.toThrow('lost commit response');
    await sink.commit(input);
    expect(await store.listPendingProviderShadowVerifications()).toHaveLength(1);
    expect(store.notificationEvents.size).toBe(0);
  });

  it('keeps a graduation-only new-grad role open and browsable after regrading an expired canonical season', async () => {
    const store = new MemoryInternshipStore();
    const sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(observedAt));
    const processed = processPosting({
      sourceId, externalId, provenance: 'official-ats',
      sourceUrl: 'https://jobs.example.com/board', fetchedAt: observedAt,
      employer: { id: 'acme', name: 'Acme', authority: 'reviewed-registry' },
      title: 'Software Engineer - New Grad', locations: ['Remote'],
      content: [{ kind: 'description', format: 'plain', value: 'Must be graduating in Fall 2026 or Spring 2027.' }],
      applyUrl: listing().applyUrl, sourceState: 'open', lifecycleAuthority: 'title',
    }).listing!;
    const incoming = { ...processed, postingIdentityDecision: listing().postingIdentityDecision };
    await sink.commit(commit({ listing: incoming, baseline: true, notify: false }));
    const initial = [...store.jobs.values()][0]!;
    store.jobs.set(initial.jobId, { ...initial, season: 'fall-2026', open: false });
    await sink.commit(commit({ listing: incoming, baseline: true, notify: false }));
    const repaired = store.jobs.get(initial.jobId)!;
    expect(repaired.season).toBe('ongoing');
    expect(repaired.open).toBe(true);
    expect(catalogPublishable(repaired)).toBe(true);
    expect(repaired.graduationWindow).toEqual({ start: '2026-12', end: '2027-05' });
    expect(store.notificationEvents.size).toBe(0);
  });
  it.each([
    'This Summer 2027 internship is open to students graduating in Spring 2028.',
    'Students graduating in Spring 2028 may apply; the internship starts in Summer 2027.',
  ])('preserves the role season through quiet canonical reopening and duplicate delivery: %s', async (description) => {
    const store = new MemoryInternshipStore();
    const sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(observedAt));
    const processed = processPosting({
      sourceId, externalId, provenance: 'official-ats', sourceUrl: 'https://jobs.example.com/board', fetchedAt: observedAt,
      employer: { id: 'acme', name: 'Acme', authority: 'reviewed-registry' },
      title: 'Software Engineering Intern', locations: ['Remote'],
      content: [{ kind: 'description', format: 'plain', value: description }],
      applyUrl: listing().applyUrl, sourceState: 'open', lifecycleAuthority: 'title',
    }).listing!;
    expect(processed.season).toBe('summer-2027');
    const input = commit({ listing: { ...processed, postingIdentityDecision: listing().postingIdentityDecision }, baseline: true, notify: false });
    await sink.commit(input);
    const original = [...store.jobs.values()][0]!;
    store.jobs.set(original.jobId, { ...original, season: 'fall-2026', open: false });
    await sink.commit(input);
    await sink.commit(input);
    expect(store.jobs.size).toBe(1);
    expect(store.jobs.get(original.jobId)).toMatchObject({ season: 'summer-2027', open: true });
    expect(catalogPublishable(store.jobs.get(original.jobId)!)).toBe(true);
    expect(store.occurrences.size).toBe(1);
    expect(store.notificationEvents.size).toBe(0);
  });

  it('keeps an employer-confirmed open role open when its explicit description season has begun', async () => {
    const store = new MemoryInternshipStore();
    const sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(observedAt));
    const processed = processPosting({
      sourceId, externalId, provenance: 'official-ats',
      sourceUrl: 'https://jobs.example.com/board', fetchedAt: observedAt,
      employer: { id: 'acme', name: 'Acme', authority: 'reviewed-registry' },
      title: 'Software Engineer - New Grad', locations: ['Remote'],
      content: [{ kind: 'description', format: 'plain', value: 'Join our engineering team in Fall 2026.' }],
      applyUrl: listing().applyUrl, sourceState: 'open', lifecycleAuthority: 'title',
    }).listing!;
    const incoming = { ...processed, postingIdentityDecision: listing().postingIdentityDecision };
    await sink.commit(commit({ listing: incoming, baseline: true, notify: false }));
    const job = [...store.jobs.values()][0]!;
    expect(job.open).toBe(true);
    // Regrade an existing closed canonical row, as in the real Lever failure.
    store.jobs.set(job.jobId, { ...job, open: false });
    await sink.commit(commit({ listing: incoming, baseline: true, notify: false }));
    expect(store.jobs.get(job.jobId)?.open).toBe(true);
    expect([...store.occurrences.values()][0]?.occurrence.state).toBe('open');
    expect(store.notificationEvents.size).toBe(0);
  });
  it('commits one catalog job, occurrence, and notification across duplicate delivery', async () => {
    const store = new MemoryInternshipStore();
    const sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(observedAt));
    await sink.commit(commit());
    await sink.commit(commit());
    expect(store.jobs.size).toBe(1);
    expect(store.occurrences.size).toBe(1);
    expect(store.notificationEvents.size).toBe(1);
  });

  it('commits baseline and migration-style work without a notification receipt', async () => {
    const store = new MemoryInternshipStore();
    const sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(observedAt));
    await sink.commit(commit({ baseline: true, notify: false }));
    expect(store.jobs.size).toBe(1);
    expect(store.occurrences.size).toBe(1);
    expect(store.notificationEvents.size).toBe(0);
  });

  it('recovers after the catalog commit succeeds but the caller observes a failure', async () => {
    class FailAfterFirstCommitStore extends MemoryInternshipStore {
      failed = false;
      override async commitPostingObservation(input: Parameters<MemoryInternshipStore['commitPostingObservation']>[0]) {
        const result = await super.commitPostingObservation(input);
        if (!this.failed) {
          this.failed = true;
          throw new Error('connection lost after commit');
        }
        return result;
      }
    }
    const store = new FailAfterFirstCommitStore();
    const sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(observedAt));
    await expect(sink.commit(commit())).rejects.toThrow('connection lost after commit');
    await expect(sink.commit(commit())).resolves.toBeUndefined();
    expect(store.jobs.size).toBe(1);
    expect(store.occurrences.size).toBe(1);
    expect(store.notificationEvents.size).toBe(1);
  });
});
