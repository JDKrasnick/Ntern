import { describe, expect, it } from 'vitest';
import {
  collectManifestViolations,
  GREENHOUSE_FIXTURE_ROOT,
  nodeManifestFs,
  type ManifestFs,
} from '../src/sources/greenhouse-manifest.js';
import { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';
import {
  acmeJobsResponse,
  acmeSource as source,
  nontechnicalInternship,
  prospectPost,
  technicalInternship,
} from './fixtures/greenhouse.js';

const validApproval = {
  sourceId: source.id,
  runAt: '2026-07-24T18:00:00Z',
  commitSha: 'abc1234',
  counts: { raw: 4, eligible: 1, withheld: 3 },
  hostSummary: 'job-boards.greenhouse.io',
};

function memoryFs(files: Record<string, unknown>): ManifestFs {
  return {
    listBoardDirs: (root) => {
      const prefix = `${root}/`;
      const dirs = new Set<string>();
      for (const path of Object.keys(files)) {
        if (path.startsWith(prefix)) dirs.add(path.slice(prefix.length).split('/')[0]);
      }
      return [...dirs];
    },
    fileExists: (path) => path in files,
    readJson: (path) => {
      const value = files[path];
      if (typeof value === 'string') return JSON.parse(value);
      return value;
    },
  };
}

const dir = `${GREENHOUSE_FIXTURE_ROOT}/${source.boardToken}`;
const completeFixtures = {
  [`${dir}/identity.json`]: { name: 'Acme Robotics' },
  [`${dir}/jobs.json`]: acmeJobsResponse,
  [`${dir}/approval.json`]: validApproval,
};

describe('greenhouse manifest', () => {
  it('passes for a fully documented reviewed board', () => {
    expect(collectManifestViolations([source], memoryFs(completeFixtures))).toEqual([]);
  });

  it('gates an empty-board acknowledgement on an owner, a reason, and a fresh timestamp', () => {
    const clock = new Date('2026-07-25T00:00:00Z');
    const acknowledged = { ...source, emptyBoardAcknowledged: { acknowledgedBy: 'JDKrasnick', acknowledgedAt: '2026-07-24T18:00:00Z', reason: 'seasonally empty' } };
    expect(collectManifestViolations([acknowledged], memoryFs(completeFixtures), GREENHOUSE_FIXTURE_ROOT, clock)).toEqual([]);
    const malformed = { ...source, emptyBoardAcknowledged: { acknowledgedBy: '', acknowledgedAt: 'not-a-timestamp', reason: ' ' } };
    expect(collectManifestViolations([malformed], memoryFs(completeFixtures), GREENHOUSE_FIXTURE_ROOT, clock)).toEqual([
      `${source.id}: empty-board acknowledgement lacks an owner`,
      `${source.id}: empty-board acknowledgement lacks a reason`,
      `${source.id}: empty-board acknowledgement timestamp is invalid`,
    ]);
    const future = { ...source, emptyBoardAcknowledged: { acknowledgedBy: 'JDKrasnick', acknowledgedAt: '2026-07-25T00:06:00Z', reason: 'seasonally empty' } };
    expect(collectManifestViolations([future], memoryFs(completeFixtures), GREENHOUSE_FIXTURE_ROOT, clock)).toEqual([
      `${source.id}: empty-board acknowledgement timestamp is in the future`,
    ]);
    const stale = { ...source, emptyBoardAcknowledged: { acknowledgedBy: 'JDKrasnick', acknowledgedAt: '2026-01-01T00:00:00Z', reason: 'seasonally empty' } };
    expect(collectManifestViolations([stale], memoryFs(completeFixtures), GREENHOUSE_FIXTURE_ROOT, clock)).toEqual([
      `${source.id}: empty-board acknowledgement is overdue for re-verification (limit 180 days)`,
    ]);
  });

  it('fails when a reviewed board ships no fixture material', () => {
    const violations = collectManifestViolations([source], memoryFs({}));
    expect(violations).toEqual([
      `${source.id}: missing identity.json`,
      `${source.id}: missing jobs.json`,
      `${source.id}: missing approval.json`,
    ]);
  });

  it('fails when a fixture directory has no reviewed source', () => {
    const violations = collectManifestViolations([], memoryFs(completeFixtures));
    expect(violations).toContain('fixture directory "acmerobotics" has no matching reviewed source');
  });

  it('rejects an approval artifact missing required fields', () => {
    const { hostSummary, ...withoutHost } = validApproval;
    void hostSummary;
    const violations = collectManifestViolations(
      [source],
      memoryFs({ ...completeFixtures, [`${dir}/approval.json`]: withoutHost }),
    );
    expect(violations).toEqual([`${source.id}: approval.json hostSummary is required`]);
  });

  it('rejects an approval artifact whose sourceId does not match', () => {
    const violations = collectManifestViolations(
      [source],
      memoryFs({ ...completeFixtures, [`${dir}/approval.json`]: { ...validApproval, sourceId: 'greenhouse-other' } }),
    );
    expect(violations).toEqual([`${source.id}: approval.json sourceId does not match the reviewed source`]);
  });

  it('requires the approval timestamp to be explicitly UTC', () => {
    const violations = collectManifestViolations(
      [source],
      memoryFs({ ...completeFixtures, [`${dir}/approval.json`]: { ...validApproval, runAt: '2026-07-24T14:00:00-04:00' } }),
    );
    expect(violations).toEqual([`${source.id}: approval.json runAt must be a UTC timestamp`]);
  });

  it('reports invalid approval JSON without throwing', () => {
    const violations = collectManifestViolations(
      [source],
      memoryFs({ ...completeFixtures, [`${dir}/approval.json`]: '{ not json' }),
    );
    expect(violations).toEqual([`${source.id}: approval.json is not valid JSON`]);
  });

  it('rejects an identity fixture whose name is not the reviewed board name', () => {
    const violations = collectManifestViolations(
      [source],
      memoryFs({ ...completeFixtures, [`${dir}/identity.json`]: { name: 'Acme Robotics Holdings' } }),
    );
    expect(violations).toEqual([`${source.id}: identity.json name does not match expectedBoardNames`]);
  });

  it('requires jobs material to cover eligible, non-eligible, and prospect rows', () => {
    const cases: Array<[unknown[], string]> = [
      [[nontechnicalInternship, prospectPost], 'jobs.json needs at least one eligible technical early-career role'],
      [[technicalInternship, prospectPost], 'jobs.json needs at least one non-eligible role'],
      [[technicalInternship, nontechnicalInternship], 'jobs.json needs at least one prospect post'],
    ];
    for (const [jobs, expected] of cases) {
      const violations = collectManifestViolations([source], memoryFs({ ...completeFixtures, [`${dir}/jobs.json`]: { jobs } }));
      expect(violations).toEqual([`${source.id}: ${expected}`]);
    }
  });

  it('rejects jobs material that is malformed, off-host, or carries tracking parameters', () => {
    const cases: Array<[unknown, string]> = [
      [{ jobs: 'nope' }, 'jobs.json must contain a jobs array'],
      [{ jobs: [{ ...technicalInternship, updated_at: 'not-a-date' }] }, 'jobs.json contains a row that is not a documented Greenhouse job shape'],
      [{ jobs: [{ ...technicalInternship, absolute_url: 'https://apply.evil.test/5001' }] }, 'jobs.json application host apply.evil.test is not a reviewed initial host'],
      [{ jobs: [{ ...technicalInternship, absolute_url: 'https://boards.greenhouse.io/acmerobotics/jobs/5001?gh_src=tracking' }] }, 'jobs.json row 5001 keeps a query string; sanitize it'],
    ];
    for (const [jobs, expected] of cases) {
      const violations = collectManifestViolations([source], memoryFs({ ...completeFixtures, [`${dir}/jobs.json`]: jobs }));
      expect(violations).toEqual([`${source.id}: ${expected}`]);
    }
  });

  it('holds for the checked-in registry against the real filesystem', () => {
    expect(collectManifestViolations(reviewedGreenhouseSources, nodeManifestFs())).toEqual([]);
  });
});
