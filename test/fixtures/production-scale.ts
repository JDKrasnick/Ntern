import type { AshbyPosting } from '../../src/sources/ashby.js';
import { ASHBY_API_VERSION } from '../../src/sources/ashby-probe.js';
import type { GreenhouseJob } from '../../src/sources/greenhouse.js';
import type { LeverPosting } from '../../src/sources/lever.js';
import type { SourceOccurrenceState } from '../../src/types.js';

/**
 * Production-scale generators for the resource-budget regression.
 *
 * Sizes are the values measured against the deployed catalog on 2026-09-16
 * (see `docs/197-ingestion-resource-bounds.md`). Payloads are generated in
 * process — no multi-megabyte fixture is checked in — and the filler text is
 * pseudo-random so retained sizes reflect real documents rather than one shared
 * constant string.
 */
export const PRODUCTION_GITHUB_DOCUMENT = { bytes: 1_671_339, htmlRows: 4_716 };
/**
 * Current public community-feed shapes captured 2026-09-21 for #317. Keep the
 * raw counts separate from eligible counts: source acquisition must finish even
 * when policy withholds rows.
 */
export const PRODUCTION_GITHUB_FEEDS = {
  simplify: { rawRows: 3_302, eligibleRows: 2_851, bytes: 2_849_080 },
  speedyapplySwe: { rawRows: 1_140, eligibleRows: 1_118, bytes: 379_082 },
  speedyapplyAi: { rawRows: 1_037, eligibleRows: 1_013, bytes: 350_623 },
  growth: { rawRows: 6_000, eligibleRows: 5_100, bytes: 5_200_000 },
} as const;
export const PRODUCTION_GITHUB_SOURCE_ROWS = PRODUCTION_GITHUB_FEEDS.simplify.rawRows;
export const PRODUCTION_GITHUB_OCCURRENCES = 4_194;
export const PRODUCTION_GREENHOUSE_BOARD_BYTES = { spacex: 27_849_116, anduril: 40_679_935 };
/** Reviewed sources per provider in production, used to size the e2e cycle. */
export const PRODUCTION_FLEET = { greenhouse: 166, lever: 6, ashby: 36, github: 6 };

/** Deterministic pseudo-random lowercase filler of exactly `length` characters. */
export function pseudoRandomText(length: number, seed: number): string {
  const bytes = Buffer.allocUnsafe(length);
  let state = (seed >>> 0) || 1;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = 97 + ((state >>> 26) % 26);
  }
  return bytes.toString('latin1');
}

const applicationHosts = ['careers-a.example.test', 'careers-b.example.test'];
/**
 * Two application hosts, so a generated curated-source board satisfies the
 * reviewed-source quality policy (at least two hosts, no host above 85%) and
 * exercises the same path production boards do.
 */
const applyUrl = (index: number) => `https://${applicationHosts[index % applicationHosts.length]}/board/role-${index}`;

/**
 * A source document whose rows are all parseable. `bytesPerRow` includes the
 * row's markup, so `rows * bytesPerRow` reproduces a measured document size.
 * HTML tables are separated by blank lines so a line-numbered parse is
 * exercised across them.
 */
export function syntheticMarkdownTable(options: {
  rows: number;
  bytesPerRow: number;
  format?: 'gfm' | 'html';
  seed?: number;
  technicalRows?: number;
}): string {
  const seed = options.seed ?? 7;
  const title = (index: number) => index < (options.technicalRows ?? options.rows)
    ? 'Software Engineering Intern'
    : 'Marketing Intern';
  const row = (index: number, detail: string) => options.format === 'gfm'
    ? `| Acme ${index} | ${title(index)} | Remote | [Apply](${applyUrl(index)}) | ${detail} |`
    : `<tr><td><strong>Acme ${index}</strong></td><td>${title(index)}</td><td>Remote</td>`
      + `<td><a href="${applyUrl(index)}">Apply</a></td><td>${detail}</td></tr>`;
  const detailLength = Math.max(0, options.bytesPerRow - row(0, '').length - 1);
  const parts = options.format === 'gfm'
    ? ['| Company | Role | Location | Apply | Detail |', '| --- | --- | --- | --- | --- |']
    : ['# Board', '', '<table>', '<thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Application</th><th>Detail</th></tr></thead>', '<tbody>'];
  for (let index = 0; index < options.rows; index += 1) {
    parts.push(row(index, pseudoRandomText(detailLength, seed + index)));
    if (options.format !== 'gfm' && index % 4 === 3) parts.push('');
  }
  parts.push(options.format === 'gfm' ? '' : '</tbody></table>');
  return `${parts.join('\n')}\n`;
}

/** One `content=true` board response at the measured byte size per job. */
export function syntheticGreenhouseBoard(options: { jobs: number; bytesPerJob: number; seed?: number }): GreenhouseJob[] {
  const seed = options.seed ?? 11;
  const detailLength = Math.max(0, options.bytesPerJob - 600);
  return Array.from({ length: options.jobs }, (_, index) => ({
    id: 900_000 + index,
    internal_job_id: 500_000 + index,
    title: 'Software Engineering Intern',
    updated_at: '2026-09-10T12:00:00-04:00',
    absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${900_000 + index}`,
    location: { name: 'Remote' },
    departments: [{ id: 1, name: 'Engineering' }],
    offices: [{ id: 2, name: 'Remote' }],
    content: `<div>${pseudoRandomText(detailLength, seed + index)}</div>`,
  }));
}

/** One Lever board page (`limit` postings) at the measured byte size per posting. */
export function syntheticLeverPages(options: { pages: number; postingsPerPage: number; bytesPerPosting: number; site?: string; seed?: number }): LeverPosting[][] {
  const site = options.site ?? 'acme';
  const seed = options.seed ?? 13;
  const detailLength = Math.max(0, options.bytesPerPosting - 400);
  return Array.from({ length: options.pages }, (_, page) => Array.from({ length: options.postingsPerPage }, (_, offset) => {
    const index = page * options.postingsPerPage + offset;
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    return {
      id,
      text: 'Software Engineering Intern, Summer 2027',
      applyUrl: `https://jobs.lever.co/${site}/${id}/apply`,
      hostedUrl: `https://jobs.lever.co/${site}/${id}`,
      descriptionPlain: pseudoRandomText(detailLength, seed + index),
      createdAt: 1_783_072_000_000 + index * 1_000,
      categories: { location: 'New York, NY', commitment: 'Internship' },
      workplaceType: 'hybrid',
    };
  }));
}

/** One Ashby posting-api board response. */
export function syntheticAshbyBoard(options: { postings: number; bytesPerPosting: number; board?: string; seed?: number }): { apiVersion: string; jobs: AshbyPosting[] } {
  const board = options.board ?? 'Acme';
  const seed = options.seed ?? 17;
  const detailLength = Math.max(0, options.bytesPerPosting - 400);
  return {
    apiVersion: ASHBY_API_VERSION,
    jobs: Array.from({ length: options.postings }, (_, index) => {
      const id = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
      return {
        id,
        title: 'Software Engineer Intern',
        location: 'New York',
        secondaryLocations: [],
        isListed: true,
        isRemote: false,
        workplaceType: 'Hybrid',
        descriptionHtml: `<p>${pseudoRandomText(detailLength, seed + index)}</p>`,
        descriptionPlain: null,
        publishedAt: '2026-08-09T12:00:00.000+00:00',
        employmentType: 'Intern',
        jobUrl: `https://jobs.ashbyhq.com/${board}/${id}`,
        applyUrl: `https://jobs.ashbyhq.com/${board}/${id}/application`,
      };
    }),
  };
}

/** Occurrence rows for one source, each padded to the measured row size. */
export function syntheticOccurrences(options: { rows: number; bytesPerRow: number; sourceId: string; seed?: number }): SourceOccurrenceState[] {
  const seed = options.seed ?? 19;
  const detailLength = Math.max(0, options.bytesPerRow - 900);
  const observedAt = '2026-09-09T00:00:00.000Z';
  return Array.from({ length: options.rows }, (_, index) => ({
    sourceId: options.sourceId,
    externalId: `role-${index}`,
    jobId: `job-${index}`,
    occurrence: {
      sourceId: options.sourceId,
      externalId: `role-${index}`,
      document: 'README.md',
      sourceUrl: 'https://raw.githubusercontent.com/acme/internships/main/README.md',
      row: index + 1,
      company: `Acme ${index}`,
      title: 'Software Engineering Intern',
      location: 'Remote',
      season: 'summer-2027',
      applyUrl: applyUrl(index),
      compensation: { raw: pseudoRandomText(detailLength, seed + index) },
      state: 'open',
    },
    present: true,
    consecutiveOmissions: 0,
    changedSnapshotHash: `hash-${index}`,
    changedAt: observedAt,
    firstObservedAt: observedAt,
    firstObservedAtPrecision: 'exact',
  }));
}
