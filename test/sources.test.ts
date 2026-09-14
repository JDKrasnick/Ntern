import { afterEach, describe, expect, it, vi } from 'vitest';
import { Poller } from '../src/poll.js';
import { parseInternshipMarkdown } from '../src/core/markdown.js';
import { GitHubMarkdownAdapter, defaultSources } from '../src/sources/github.js';
import { defaultSources as productionSources } from '../src/sources/index.js';
import { parseQuantInternshipMarkdown } from '../src/sources/quant.js';
import { MemoryInternshipStore } from '../src/store.js';

describe('GitHub source adapters', () => {
  afterEach(() => vi.useRealTimers());
  it('bounds a fetch that never returns headers or honors cancellation', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const adapter = new GitHubMarkdownAdapter({
      id: 'fixture', owner: 'owner', repo: 'repo', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: (_url, init) => { signal = init?.signal; return new Promise(() => undefined); },
    });
    const failed = expect(adapter.fetch()).rejects.toMatchObject({ category: 'transport', retryable: true, message: 'fixture: README.md fetch timed out' });
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses one deadline for delayed headers and a stalled body without parsing a partial snapshot', async () => {
    vi.useFakeTimers();
    const parser = vi.fn(() => []);
    const adapter = new GitHubMarkdownAdapter({
      id: 'fixture', owner: 'owner', repo: 'repo', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }], parser,
      fetchImpl: async () => {
        await new Promise(resolve => setTimeout(resolve, 10_000));
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('| partial')); } }));
      },
    });
    const failed = expect(adapter.fetch()).rejects.toMatchObject({ category: 'transport', retryable: true });
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(parser).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases HTTP error bodies without waiting for a stalled cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const adapter = new GitHubMarkdownAdapter({
      id: 'fixture', owner: 'owner', repo: 'repo', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: async () => new Response(new ReadableStream({ cancel }), { status: 503 }),
    });
    await expect(adapter.fetch()).rejects.toMatchObject({ category: 'http', status: 503, retryable: true });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('ships each active feed and document', () => {
    expect(defaultSources.map((source) => source.id)).toEqual(['vanshb03-summer-2027', 'simplify-summer-2026', 'speedyapply-2027-swe', 'speedyapply-2027-ai', 'northwestern-fintech-2027-quant', 'canadian-tech-2027']);
  });
  it('keeps queued Greenhouse and Lever work outside the general poll registry', () => {
    expect(productionSources.filter((source) => source.id.startsWith('lever-'))).toEqual([]);
    expect(productionSources.filter((source) => source.id.startsWith('greenhouse-'))).toEqual([]);
  });
  it('uses document-specific ETags and returns a no-change result', async () => {
    const calls: RequestInit[] = [];
    const adapter = new GitHubMarkdownAdapter({ id: 'fixture', owner: 'owner', repo: 'repo', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }], fetchImpl: async (_url, init) => { calls.push(init ?? {}); return new Response(null, { status: 304 }); } });
    const result = await adapter.fetch({ sourceId: 'fixture', successfulFetches: 1, documentEtags: { 'README.md': '"abc"' } });
    expect(result).toMatchObject({ notModified: true, unchangedReason: 'not_modified' }); expect(calls[0].headers).toEqual({ 'If-None-Match': '"abc"' });
  });
  it('keeps a snapshot complete when two rows share one normalized application URL', async () => {
    const adapter = new GitHubMarkdownAdapter({
      id: 'fixture', owner: 'owner', repo: 'repo', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: async () => new Response('| Company | Position | Location | Posting |\n| --- | --- | --- | --- |\n'
        + '| Acme | Software Engineering Intern | Remote | [Apply](https://careers.example.test/acme?utm_source=one) |\n'
        + '| Acme | Data Science Intern | Remote | [Apply](https://careers.example.test/acme?utm_source=two) |'),
    });
    const result = await adapter.fetch();
    expect(result.postings.map((posting) => posting.title)).toEqual(['Software Engineering Intern']);
    expect(result.rawCount).toBe(2);
    expect(result.trustedCommunityDiagnostics).toMatchObject({ duplicateOccurrenceIds: 1 });
  });
  it('reports count-only aggregator rejection diagnostics', async () => {
    const adapter = new GitHubMarkdownAdapter({
      id: 'fixture', owner: 'owner', repo: 'repo', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: async () => new Response('| Company | Position | Location | Posting |\n| --- | --- | --- | --- |\n'
        + '| Acme | Software Engineering Intern | Remote | [Apply](https://www.indeed.com/viewjob?jk=one) |'),
    });
    const result = await adapter.fetch();
    expect(result.trustedCommunityDiagnostics).toEqual({
      rejectedAggregatorRows: 1, survivingAggregatorRows: 0, duplicateOccurrenceIds: 0,
    });
  });
  it('lets a reviewed list carry the lifecycle signal for a row whose title omits it', async () => {
    const adapter = new GitHubMarkdownAdapter({
      id: 'fixture', owner: 'owner', repo: 'repo', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: async () => new Response('| Company | Position | Location | Posting |\n| --- | --- | --- | --- |\n'
        + '| Acme | Software Engineer, New Grad | Remote | [Apply](https://careers.example.test/acme) |'),
    });
    const result = await adapter.fetch();
    expect(result.listings.map((listing) => listing.title)).toEqual(['Software Engineer, New Grad']);
  });
  it('assigns the employer category while polling a GitHub Markdown source', async () => {
    const adapter = new GitHubMarkdownAdapter({
      id: 'fixture', owner: 'owner', repo: 'repo', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: async () => new Response('| Company | Role | Location | Apply |\n| --- | --- | --- | --- |\n| Google | Software Engineering Intern | Remote | [Apply](https://careers.example.test/google) |'),
    });
    const store = new MemoryInternshipStore();
    await new Poller([adapter], store).poll();
    expect([...store.jobs.values()][0]).toMatchObject({ company: 'Google', employerCategory: 'faang' });
  });
  it('recognizes a Posting column as the direct application URL', () => {
    const rows = parseInternshipMarkdown('| Company | Position | Posting |\n| --- | --- | --- |\n| Acme | AI Intern | <a href="https://careers.example.test/acme">Apply</a> |', { sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://github.com/example/roles', season: 'summer-2027' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.applyUrl).toBe('https://careers.example.test/acme');
  });
  it('parses quant roles nested under an employer heading', () => {
    const rows = parseQuantInternshipMarkdown('## Acme Capital\n\n**Locations**: Chicago\n\n|Role|Links|\n|---|---|\n|SWE|[✅ C++](https://careers.example.test/acme-cpp) [✅ Python](https://careers.example.test/acme-python)|', { sourceId: 'quant', document: 'README.md', sourceUrl: 'https://github.com/example/quant', season: 'summer-2027' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ company: 'Acme Capital', title: 'Software Engineering Intern — C++', location: 'Chicago' });
  });
});
