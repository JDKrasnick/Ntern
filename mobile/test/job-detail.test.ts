import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  destinationFromNotification,
  destinationFromUrl,
  freshnessLabel,
  isNewJob,
  isDuplicateJobOpen,
  jobOpenDisposition,
  jobDetailPresentation,
  jobDeepLink,
  postingTimingPresentation,
  postingRecencyBadge,
  releaseDeepLink,
  routeFailureState,
  shouldPushJobHistory,
  sourcePresentation,
  validatedOfficialUrl,
} from '../src/job-detail.js';

describe('mobile job routes', () => {
  it('opens a grouped role through the immediate catalog-card path', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const handler = /const openGroupedRole = \(job: Job\) => \{(?<body>[\s\S]*?)\n  \};/.exec(app);

    expect(app).toContain('onPress={() => onOpenRole(catalogRoleJob(item))}');
    expect(handler?.groups?.body).toContain('openCatalogJob(job);');
    expect(handler?.groups?.body).not.toContain('presentDestination');
    expect(handler?.groups?.body).not.toContain('InteractionManager');
  });

  it('keeps the grouped sheet stable with role-shaped loading placeholders', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    expect(app).toContain('<CatalogGroupLoadingSkeleton />');
    expect(app).toContain('accessibilityLabel="Loading grouped roles"');
    expect(app).not.toContain('<Text style={styles.catalogPaginationText}>Loading roles…</Text>');
  });

  it('fades the role-sheet dim on mobile and web while using a quadratic sheet transition', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    expect(app.match(/useSheetEntranceOffset\(/g)).toHaveLength(2);
    expect(app).toContain('function useRoleSheetTransition(visible: boolean, onDismiss: () => void)');
    expect(app).toContain('const dimOpacity = useRef(new Animated.Value(0)).current;');
    expect(app).toContain('const entranceDistance = Platform.OS === "web" ? 40 : 72;');
    expect(app).not.toContain('const isMobile = Platform.OS !== "web";');
    expect(app).toContain('easing: Easing.out(Easing.quad)');
    expect(app).toContain('easing: Easing.in(Easing.quad)');
    expect(app).toContain('style={[styles.sheetOverlay, { opacity: roleSheet.dimOpacity }]}');
    expect(app).toContain('Platform.OS === "web" ? 40 : 72');
    expect(app).toContain('Platform.OS === "web" ? 180 : 240');
    expect(app).toContain('useLayoutEffect(() => {');
    expect(app).toContain('easing: Easing.bezier(0.16, 1, 0.3, 1)');
    expect(app).not.toContain('new Animated.Value(windowHeight)');
  });

  it('parses compatible notification payloads and encoded app URLs', () => {
    expect(destinationFromNotification({ jobId: 'legacy/job' })).toEqual({ kind: 'job', jobId: 'legacy/job', reasons: [], exclusionsApplied: false });
    expect(destinationFromNotification({ applicationId: 'application-1', destination: 'saved' })).toEqual({ kind: 'saved' });
    expect(destinationFromNotification({ destination: 'release', releaseId: 'release/1' })).toEqual({ kind: 'release', releaseId: 'release/1' });
    const url = jobDeepLink('role/with spaces');
    expect(url).toBe('internnotifs://jobs/role%2Fwith%20spaces');
    expect(destinationFromUrl(url)).toEqual({ kind: 'job', jobId: 'role/with spaces', reasons: [], exclusionsApplied: false });
    expect(destinationFromUrl(releaseDeepLink('release/1'))).toEqual({ kind: 'release', releaseId: 'release/1' });
    expect(destinationFromUrl('https://example.com/jobs/role')).toBeUndefined();
  });

  it('keeps valid structured match reasons and ignores malformed values', () => {
    expect(destinationFromNotification({
      jobId: 'role-1',
      matchedFilters: { reasons: [{ kind: 'category', label: 'AI/ML' }, { kind: 'unknown', label: 'Nope' }], exclusionsApplied: true },
    })).toEqual({ kind: 'job', jobId: 'role-1', reasons: [{ kind: 'category', label: 'AI/ML' }], exclusionsApplied: true });
  });

  it('suppresses duplicate initial events for the active role', () => {
    expect(isDuplicateJobOpen('role-1', 'role-1')).toBe(true);
    expect(isDuplicateJobOpen('role-1', 'role-2')).toBe(false);
    expect(isDuplicateJobOpen('role-1', 'role-1', true)).toBe(false);
  });

  it('serializes role replacement through native sheet dismissal', () => {
    expect(jobOpenDisposition(undefined, 'role-1')).toBe('open');
    expect(jobOpenDisposition('role-1', 'role-1')).toBe('ignore');
    expect(jobOpenDisposition('role-1', 'role-2')).toBe('replace');
    expect(jobOpenDisposition(undefined, 'role-2', true)).toBe('replace');
  });

  it('does not push a duplicate history entry for an initial job URL', () => {
    expect(shouldPushJobHistory('role-1', 'role-1')).toBe(false);
    expect(shouldPushJobHistory('role-1', 'role-2')).toBe(true);
    expect(shouldPushJobHistory(null, 'role-1')).toBe(true);
  });

  it('keeps one sheet mounted while a routed role changes from loading to detail', () => {
    expect(jobDetailPresentation(false, 'idle')).toEqual({ visible: false, content: 'hidden' });
    expect(jobDetailPresentation(false, 'loading')).toEqual({ visible: true, content: 'route' });
    expect(jobDetailPresentation(true, 'idle')).toEqual({ visible: true, content: 'job' });
    expect(jobDetailPresentation(false, 'missing')).toEqual({ visible: true, content: 'route' });
    expect(jobDetailPresentation(false, 'error')).toEqual({ visible: true, content: 'route' });
  });
});

describe('mobile job trust and freshness', () => {
  it('distinguishes official, community, and corroborated sources', () => {
    expect(sourcePresentation([{ sourceId: 'greenhouse-acme', provenance: 'official-ats' }])).toEqual({ primary: 'Official ATS', corroboration: undefined, labels: ['Official ATS'] });
    expect(sourcePresentation([{ sourceId: 'employer-acme', provenance: 'employer-submitted' }, { sourceId: 'lever-acme', provenance: 'official-ats' }, { sourceId: 'community-list', provenance: 'reviewed-community' }])).toEqual({ primary: 'Employer submitted', corroboration: 'Also: Official ATS · Reviewed community source', labels: ['Employer submitted', 'Official ATS', 'Reviewed community source'] });
    expect(sourcePresentation([{ sourceId: 'community-list', provenance: 'reviewed-community' }])).toEqual({ primary: 'Reviewed community source', corroboration: undefined, labels: ['Reviewed community source'] });
    expect(sourcePresentation([{ sourceId: 'submitted', provenance: 'employer-submitted', state: 'closed' }, { sourceId: 'official', provenance: 'official-structured' }]).primary).toBe('Official structured source');
    expect(sourcePresentation([])).toEqual({ primary: 'Source unavailable', corroboration: undefined, labels: [] });
  });

  it('uses relative confirmation times for recent checks and dates for older checks', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    expect(freshnessLabel('2026-08-10T08:00:00Z', now)).toBe('Confirmed today');
    expect(freshnessLabel('2026-08-08T08:00:00Z', now)).toBe('Confirmed 2 days ago');
    expect(freshnessLabel('2026-08-01T08:00:00Z', now)).toMatch(/^Confirmed Aug 1, 2026$/);
  });

  it('shows an employer publication time separately from InternNotifs discovery', () => {
    const timing = postingTimingPresentation(
      [{
        sourceId: 'ashby-acme',
        postedAt: '2025-09-22T20:57:32.244Z',
        providerTimestamp: { value: '2025-09-22T20:57:32.244Z', semantics: 'published' },
      }],
      '2026-08-19T15:18:03.421Z',
      new Date('2026-08-19T17:18:03.421Z'),
    );
    expect(timing).toMatchObject({ kind: 'employer-posted', verified: true });
    expect(timing.summary).toMatch(/^Employer posted Sep 22, 2025$/);
    expect(timing.detail).toMatch(/^Employer posted Sep 22, 2025 · Verified employer date · Found by InternNotifs Aug 19, 2026$/);
    expect(postingRecencyBadge(true, timing, new Date('2026-08-19T17:18:03.421Z'))).toBeUndefined();
  });

  it('labels discovery honestly when a community feed only supplies a relative age', () => {
    const timing = postingTimingPresentation(
      [{
        sourceId: 'zapply-2027',
        postedAt: '21m',
        providerTimestamp: { value: '21m', semantics: 'published' },
      }],
      '2026-08-19T15:18:03.421Z',
      new Date('2026-08-19T17:18:03.421Z'),
    );
    expect(timing).toMatchObject({ kind: 'found', verified: false });
    expect(timing.summary).toBe('Found by InternNotifs 2h ago');
    expect(timing.detail).toMatch(/^Original posting date unavailable · Found by InternNotifs Aug 19, 2026$/);
    expect(postingRecencyBadge(true, timing, new Date('2026-08-19T17:18:03.421Z'))).toBe('New here');
  });

  it('marks an absolute community date as reported but not employer-verified', () => {
    const timing = postingTimingPresentation(
      [{
        sourceId: 'community-list',
        providerTimestamp: { value: '2026-08-19T16:00:00.000Z', semantics: 'published' },
      }],
      '2026-08-19T16:05:00.000Z',
      new Date('2026-08-19T17:18:03.421Z'),
    );
    expect(timing).toMatchObject({ kind: 'source-reported', verified: false });
    expect(timing.summary).toBe('Source reported 1h ago');
    expect(timing.detail).toMatch(/^Source reported Aug 19, 2026 · Not employer-verified/);
    expect(postingRecencyBadge(true, timing, new Date('2026-08-19T17:18:03.421Z'))).toBe('New here');
  });

  it('preserves date-only source dates across device time zones', () => {
    const timing = postingTimingPresentation(
      [{
        sourceId: 'community-list',
        providerTimestamp: { value: '2026-07-19', semantics: 'published' },
      }],
      '2026-07-20T16:05:00.000Z',
      new Date('2026-08-19T17:18:03.421Z'),
    );
    expect(timing.summary).toBe('Source reported Jul 19, 2026');
    expect(timing.detail).toBe('Source reported Jul 19, 2026 · Not employer-verified · Found by InternNotifs Jul 20, 2026');
  });

  it('keeps the New badge for a recently published internship', () => {
    const timing = postingTimingPresentation(
      [{
        sourceId: 'lever-acme',
        providerTimestamp: { value: '2026-08-19T16:00:00.000Z', semantics: 'published' },
      }],
      '2026-08-19T16:05:00.000Z',
      new Date('2026-08-19T17:18:03.421Z'),
    );
    expect(postingRecencyBadge(true, timing, new Date('2026-08-19T17:18:03.421Z'))).toBe('New');
  });

  it('does not mislabel an official provider update as the posting date', () => {
    const timing = postingTimingPresentation(
      [{
        sourceId: 'greenhouse-acme',
        postedAt: '2026-08-19T16:00:00.000Z',
        providerTimestamp: { value: '2026-08-19T16:00:00.000Z', semantics: 'updated' },
      }],
      '2026-08-19T15:18:03.421Z',
      new Date('2026-08-19T17:18:03.421Z'),
    );
    expect(timing.summary).toBe('Found by InternNotifs 2h ago');
  });

  it('does not verify legacy official timestamps without publication semantics', () => {
    const timing = postingTimingPresentation(
      [{ sourceId: 'greenhouse-acme', postedAt: '2026-08-19T16:00:00.000Z' }],
      '2026-08-19T15:18:03.421Z',
      new Date('2026-08-19T17:18:03.421Z'),
    );
    expect(timing).toMatchObject({ kind: 'found', verified: false });
    expect(timing.summary).toBe('Found by InternNotifs 2h ago');
  });

  it('uses the previous visit for signed-in users and 72 hours for guests', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    expect(isNewJob('2026-08-09T12:00:00Z', { signedIn: true, previousCatalogOpenedAt: '2026-08-09T00:00:00Z', now })).toBe(true);
    expect(isNewJob('2026-08-08T12:00:00Z', { signedIn: true, previousCatalogOpenedAt: '2026-08-09T00:00:00Z', now })).toBe(false);
    expect(isNewJob('2026-08-07T13:00:00Z', { signedIn: false, now })).toBe(true);
    expect(isNewJob('2026-08-07T11:59:59Z', { signedIn: false, now })).toBe(false);
  });

  it('only exposes closed official links after validation', () => {
    expect(validatedOfficialUrl({ applyUrl: 'https://careers.example.com/role', applicationUrlValidatedAt: '2026-08-10T00:00:00Z' })).toBe('https://careers.example.com/role');
    expect(validatedOfficialUrl({ applyUrl: 'https://careers.example.com/role' })).toBeUndefined();
    expect(validatedOfficialUrl({ applyUrl: 'https://careers.example.com/role', applicationUrlValidatedAt: '2026-08-10T00:00:00Z', invalidApplicationUrl: 'https://careers.example.com/role' })).toBeUndefined();
  });

  it('separates missing roles from retryable route failures', () => {
    expect(routeFailureState(new Error('Job not found'))).toBe('missing');
    expect(routeFailureState(new Error('The request timed out'))).toBe('error');
  });
});
