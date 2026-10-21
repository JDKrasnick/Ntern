import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadApplicationHistory, parseApplicationHistory, rememberApplication, remainingCatalogGroup, saveApplicationHistory } from '../src/application-history';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.set(key, value); },
} }));
const job = { jobId: 'a', company: 'Employer', title: 'Software Intern', applyUrl: 'https://example.com/apply', location: 'Remote', season: 'summer-2027' };

describe('application handoff history', () => {
  beforeEach(() => storage.clear());
  it('keeps one most-recent entry per role without mutating earlier history', () => {
    const first = rememberApplication([], job, '2026-10-20T12:00:00.000Z');
    const second = rememberApplication(first, job, '2026-10-20T13:00:00.000Z');
    expect(second).toEqual([{ job, openedAt: '2026-10-20T13:00:00.000Z' }]);
    expect(first[0]?.openedAt).toBe('2026-10-20T12:00:00.000Z');
  });
  it('restores snapshots after a reload and ignores invalid or unsafe records', async () => {
    await saveApplicationHistory(rememberApplication([], job));
    expect((await loadApplicationHistory())[0]?.job).toEqual(job);
    expect(parseApplicationHistory([null, { job, openedAt: 'bad' }, { job: { ...job, applyUrl: 'javascript:alert(1)' }, openedAt: new Date().toISOString() }])).toEqual([]);
    storage.set('internnotifs.application-history.v1', '{bad json');
    expect(await loadApplicationHistory()).toEqual([]);
  });
  it('serializes successive saves so the latest history remains durable', async () => {
    const first = rememberApplication([], job);
    const next = rememberApplication(first, { ...job, jobId: 'b' });
    await Promise.all([saveApplicationHistory(first), saveApplicationHistory(next)]);
    expect(await loadApplicationHistory()).toEqual(next);
  });
  it('removes an opened individual while keeping other roles in a group', () => {
    const a = { jobId: 'a', title: 'Software Intern', opportunity: { total: 90 } };
    const b = { jobId: 'b', title: 'Data Intern', opportunity: { total: 70 } };
    const unrelated = { jobId: 'x', title: 'Older role', opportunity: { total: 100 } };
    const group = { roleIds: ['a', 'b'], roleCount: 2, featuredRole: a, titles: [a.title, b.title], opportunity: a.opportunity };
    expect(remainingCatalogGroup(group, new Set())).toBe(group);
    expect(remainingCatalogGroup(group, new Set(['a']))).toBeUndefined();
    expect(remainingCatalogGroup(group, new Set(['a']), [unrelated, a, b])).toMatchObject({ roleIds: ['b'], roleCount: 1, featuredRole: b, titles: [b.title], opportunity: b.opportunity });
    expect(remainingCatalogGroup(group, new Set(['a', 'b']), [a, b])).toBeUndefined();
  });
});
