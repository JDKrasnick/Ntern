import { describe, expect, it } from 'vitest';
import { ReconcilerAdmissionV2CatalogSink } from '../src/ingestion-v2/admission/catalog-sink.js';
import { stableSourceOccurrenceJobId } from '../src/identity/registry.js';
import { MemoryInternshipStore } from '../src/store.js';
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

describe('ingestion v2 reconciler catalog sink', () => {
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
