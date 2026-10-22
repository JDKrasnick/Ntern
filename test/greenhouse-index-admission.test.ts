import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudflareAdmissionProber } from '../cloudflare/admission-v2.js';
import { RuleBasedAdmissionV2Evaluator, type AdmissionCatalogCommit } from '../src/ingestion-v2/admission/evaluator.js';
import type { AdmissionRowContext } from '../src/ingestion-v2/admission/types.js';
import { mapGreenhouseSourcedPosting } from '../src/sources/greenhouse.js';
import { processPosting } from '../src/ingestion/processor.js';
import { normalizeSourceSnapshot, parseEnvelope, serializeEnvelope } from '../src/ingestion-v2/normalize.js';
import { ingestionV2AdmissionVersion } from '../src/ingestion-v2/admission/version.js';
import { acmeSource, technicalInternship, technicalFullTime } from './fixtures/greenhouse.js';
import { findReviewedGreenhouseSource } from '../src/sources/greenhouse-config.js';

const now = '2026-10-12T18:00:00.000Z';
const resolver = { async resolve() { return ['93.184.216.34']; } };
function context(job = technicalInternship): AdmissionRowContext {
  const posting = { ...mapGreenhouseSourcedPosting({ ...job, content: '' }, acmeSource, now)!,
    contentCompleteness: 'index-only' as const };
  return { sourceId: posting.sourceId, externalId: posting.externalId, posting,
    snapshotHash: 'a'.repeat(64), admissionVersion: 'v1', baseline: true,
    row: { sourceId: posting.sourceId, externalId: posting.externalId,
      snapshotHash: 'a'.repeat(64), materialHash: 'b'.repeat(64), admissionVersion: 'v1',
      state: 'queued', attemptCount: 0, consecutiveOmissions: 0, notificationBaseline: true,
      firstObservedAt: now, lastObservedAt: now, updatedAt: now } };
}
function setup() {
  const commits: AdmissionCatalogCommit[] = [];
  const evaluator = new RuleBasedAdmissionV2Evaluator({ now: () => new Date(now),
    prober: cloudflareAdmissionProber(resolver),
    sink: { async commit(input) { commits.push(input); } } });
  return { evaluator, commits };
}
afterEach(() => vi.unstubAllGlobals());
describe('Greenhouse index admission', () => {
  it.each([
    ['squarepointcapital', 'https://www.squarepoint-capital.com/open-opportunities/?id=5001&gh_jid=5001'],
    ['airbnb', 'https://careers.airbnb.com/positions/5001'],
    ['gemini', 'https://boards.greenhouse.io/embed/job_app?for=gemini&token=5001&gh_jid=5001'],
    ['mongodb', 'https://www.mongodb.com/careers/job/?gh_jid=5001'],
    ['pinterest', 'https://www.pinterestcareers.com/jobs/?gh_jid=5001'],
    ['roblox', 'https://careers.roblox.com/jobs/5001'],
  ])('hydrates %s from its reviewed board rather than its application URL alias', async (tenant, applyUrl) => {
    const lookup = findReviewedGreenhouseSource(`greenhouse-${tenant}`);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') throw new Error('Reviewed test source required');
    const job = { ...technicalInternship, absolute_url: applyUrl };
    const posting = { ...mapGreenhouseSourcedPosting({ ...job, content: '' }, lookup.source, now)!, contentCompleteness: 'index-only' as const };
    const input = context();
    input.sourceId = posting.sourceId;
    input.posting = posting;
    input.row.sourceId = posting.sourceId;
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      expect(new URL(String(url)).pathname).toBe(`/v1/boards/${tenant}/jobs/5001`);
      return new Response(JSON.stringify(job));
    });
    vi.stubGlobal('fetch', fetcher);
    const { evaluator, commits } = setup();
    const result = await evaluator.evaluate(input);
    expect(result.decision.kind).toBe('admitted');
    await result.commitEffect!();
    expect(commits[0]!.notify).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['tenant', 'source', 'employer', 'authority', 'host'])('refuses a forged employer-hosted index %s before fetching', async field => {
    const lookup = findReviewedGreenhouseSource('greenhouse-mongodb');
    if (lookup.status !== 'found') throw new Error('Reviewed test source required');
    const posting = { ...mapGreenhouseSourcedPosting({ ...technicalInternship, content: '', absolute_url: 'https://www.mongodb.com/careers/job/?gh_jid=5001' }, lookup.source, now)!, contentCompleteness: 'index-only' as const };
    if (field === 'tenant') posting.providerIdentity = { provider: 'greenhouse', tenant: 'other' };
    if (field === 'source') posting.sourceId = 'greenhouse-unknown';
    if (field === 'employer') posting.employer = { ...posting.employer, id: 'other' };
    if (field === 'authority') posting.employer = { ...posting.employer, authority: 'source-row' };
    if (field === 'host') posting.applyUrl = 'https://www.mongodb.com.evil.test/careers/job/?gh_jid=5001';
    const input = context(); input.sourceId = posting.sourceId; input.posting = posting; input.row.sourceId = posting.sourceId;
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(setup().evaluator.evaluate(input)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a reviewed board response with another employer application URL', async () => {
    const lookup = findReviewedGreenhouseSource('greenhouse-mongodb');
    if (lookup.status !== 'found') throw new Error('Reviewed test source required');
    const posting = { ...mapGreenhouseSourcedPosting({ ...technicalInternship, content: '', absolute_url: 'https://www.mongodb.com/careers/job/?gh_jid=5001' }, lookup.source, now)!, contentCompleteness: 'index-only' as const };
    const input = context(); input.sourceId = posting.sourceId; input.posting = posting; input.row.sourceId = posting.sourceId;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...technicalInternship, absolute_url: 'https://www.mongodb.com/careers/job/?gh_jid=5002' }))));
    await expect(setup().evaluator.evaluate(input)).rejects.toThrow('application URL identity mismatch');
  });

  it.each([
    'for=other&token=5001&gh_jid=5001',
    'for=gemini&token=5002&gh_jid=5001',
    'for=gemini&token=5001&gh_jid=5002',
    'for=gemini&for=other&token=5001&gh_jid=5001',
  ])('refuses an inconsistent embed identity before fetching: %s', async query => {
    const lookup = findReviewedGreenhouseSource('greenhouse-gemini');
    if (lookup.status !== 'found') throw new Error('Reviewed test source required');
    const posting = { ...mapGreenhouseSourcedPosting({ ...technicalInternship, content: '', absolute_url: `https://boards.greenhouse.io/embed/job_app?${query}` }, lookup.source, now)!, contentCompleteness: 'index-only' as const };
    const input = context(); input.sourceId = posting.sourceId; input.posting = posting; input.row.sourceId = posting.sourceId;
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(setup().evaluator.evaluate(input)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('versions the index transition without migrating other provider policies', () => {
    const prior = ingestionV2AdmissionVersion('standard-v1');
    expect(ingestionV2AdmissionVersion('standard-v1', { greenhouseIndexMaterial: false })).toBe(prior);
    expect(ingestionV2AdmissionVersion('standard-v1', { greenhouseIndexMaterial: true })).not.toBe(prior);
  });
  it('rejects a snapshot that labels an existing description as index-only', () => {
    const posting = { ...context().posting, content: [{ kind: 'description' as const, format: 'html' as const, value: '<p>Unverified material</p>' }] };
    const snapshot = normalizeSourceSnapshot({ sourceId: posting.sourceId, postings: [posting], admissionVersion: 'v1', observedAt: now });
    expect(() => parseEnvelope(serializeEnvelope(snapshot), { sourceId: posting.sourceId, snapshotHash: snapshot.snapshotHash }))
      .toThrow('index material is malformed');
  });
  it('grades exact official descriptions and compensation while keeping baselines silent', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).hostname).toBe('boards-api.greenhouse.io');
      return new Response(JSON.stringify(technicalInternship));
    });
    vi.stubGlobal('fetch', fetcher);
    const { evaluator, commits } = setup();
    const result = await evaluator.evaluate(context());
    expect(result.decision.kind).toBe('admitted');
    await result.commitEffect!();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.notify).toBe(false);
    expect(commits[0]!.listing).toMatchObject(processPosting(mapGreenhouseSourcedPosting(technicalInternship, acmeSource, now)!).listing!);
    expect(fetcher).toHaveBeenCalledOnce();
    const request = new URL(String(fetcher.mock.calls[0]![0]));
    expect(request.origin).toBe('https://boards-api.greenhouse.io');
    expect(request.pathname).toBe('/v1/boards/acmerobotics/jobs/5001');
  });
  it.each([
    { updated_at: '2026-07-21T12:00:00Z' },
    { title: 'Senior Software Engineer' },
    { absolute_url: 'https://job-boards.greenhouse.io/other/jobs/5001' },
    { content: undefined },
  ])('refuses provider material that does not match the retained row: %j', async mutation => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...technicalInternship, ...mutation }))));
    const { evaluator, commits } = setup();
    await expect(evaluator.evaluate(context())).rejects.toMatchObject({ classification: 'upstream-server-error' });
    expect(commits).toHaveLength(0);
  });
  it('does not fetch descriptions for a title outside early-career scope', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { evaluator, commits } = setup();
    expect((await evaluator.evaluate(context(technicalFullTime))).decision.kind).toBe('blocked');
    expect(fetcher).not.toHaveBeenCalled();
    expect(commits).toHaveLength(0);
  });
  it('cannot silently grade a live candidate when a prober omits full material', async () => {
    const evaluator = new RuleBasedAdmissionV2Evaluator({
      prober: { async probe() { return { reachability: 'live' }; } },
      sink: { async commit() { throw Error('Must not commit'); } },
    });
    await expect(evaluator.evaluate(context())).rejects.toMatchObject({ classification: 'upstream-server-error' });
  });
});
