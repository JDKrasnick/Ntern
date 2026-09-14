import { createHash } from 'node:crypto';
import { parseInternshipMarkdown, type MarkdownParseOptions } from '../core/markdown.js';
import { normalizeUrl } from '../core/normalize.js';
import { platformFetch } from '../core/platform-fetch.js';
import { processSnapshot } from '../ingestion/processor.js';
import { applicationUrlRejection } from './quality.js';
import { parseQuantInternshipMarkdown } from './quant.js';
import { SourceFetchError } from './source-error.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceConnector, SourceFetchResult, SourceSnapshot, SourcedPosting } from '../types.js';

export interface GitHubDocument { path: string; branch: string; season: string; }
export interface GitHubAdapterOptions { id: string; owner: string; repo: string; documents: GitHubDocument[]; parser?: (markdown: string, options: MarkdownParseOptions) => RawListing[]; fetchImpl?: typeof fetch; }

export function markdownListingToSourcedPosting(listing: RawListing): SourcedPosting {
  return {
    sourceId: listing.sourceId,
    provenance: 'reviewed-community',
    externalId: `${listing.document}:${normalizeUrl(listing.applyUrl)}`,
    document: listing.document,
    sourceUrl: listing.sourceUrl,
    row: listing.row,
    fetchedAt: listing.fetchedAt,
    employer: { name: listing.company, authority: 'source-row',
      ...(listing.employerLabelOrigin ? { labelOrigin: listing.employerLabelOrigin } : {}),
      ...(listing.employerInheritance ? { inheritance: listing.employerInheritance } : {}) },
    title: listing.title,
    content: [],
    locations: [listing.location],
    applyUrl: listing.applyUrl,
    sourceState: listing.state,
    // These documents are reviewed early-career lists, so a row keeps the
    // lifecycle standing the list gives it even when its title omits "intern".
    lifecycleAuthority: 'source',
    ...(listing.postedAt ? { publishedAt: listing.postedAt, providerTimestamp: { value: listing.postedAt, semantics: 'published' as const } } : {}),
    seasonHint: listing.season,
    seasonHintAuthority: 'source-default',
    compensationText: listing.compensation.raw,
    declaredRequirements: listing.requirements,
    declaredWorkMode: listing.workMode,
  };
}

function postingProjection(postings: SourcedPosting[]): string {
  return JSON.stringify(
    [...postings].sort((a, b) => a.externalId.localeCompare(b.externalId)),
    (key, value) => key === 'fetchedAt' || key === 'row' ? undefined : value,
  );
}

type TransitionalMarkdownResult = SourceSnapshot & SourceFetchResult;

export class GitHubMarkdownAdapter implements SourceAdapter, SourceConnector {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: GitHubAdapterOptions) { this.id = options.id; this.fetchImpl = options.fetchImpl ?? platformFetch; }

  private async fetchDocument(url: string, path: string, knownEtag?: string) {
    const controller = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = () => new SourceFetchError(`${this.id}: ${path} fetch timed out`, 'transport');
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(timedOut());
        controller.abort();
      }, 15_000);
    });
    try {
      const read = async () => {
        const response = await this.fetchImpl(url, {
          headers: knownEtag ? { 'If-None-Match': knownEtag } : {},
          signal: controller.signal,
        });
        if (expired || response.status === 304 || !response.ok) {
          // Do not await cancellation: an uncooperative stream must not hold
          // the queue consumer after the deadline or an HTTP failure.
          void response.body?.cancel().catch(() => undefined);
          if (expired) throw timedOut();
          if (response.status !== 304) throw new SourceFetchError(`${this.id}: ${path} fetch failed (${response.status})`, 'http', response.status);
          return { response, markdown: '' };
        }
        return { response, markdown: await response.text() };
      };
      // The same deadline covers headers and body, including fetchers that
      // fail to settle when their AbortSignal is aborted.
      return await Promise.race([read(), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }

  async fetch(previous?: SourceCheckpoint): Promise<TransitionalMarkdownResult> {
    const rawListings: RawListing[] = []; const rejectedApplicationUrls: Array<{ row: number; url: string; reason: string }> = []; const documentEtags = { ...previous?.documentEtags }; let etag: string | undefined; let allUnchanged = true;
    for (const document of this.options.documents) {
      const url = `https://raw.githubusercontent.com/${this.options.owner}/${this.options.repo}/${document.branch}/${document.path}`;
      // A 304 supplies no body. Multi-document sources therefore fetch every
      // document so a changed result is always a complete source snapshot.
      const knownEtag = this.options.documents.length === 1
        ? previous?.documentEtags?.[document.path] ?? previous?.etag
        : undefined;
      const { response, markdown } = await this.fetchDocument(url, document.path, knownEtag);
      if (response.status === 304) continue;
      allUnchanged = false; etag = response.headers.get('etag') ?? etag;
      const documentEtag = response.headers.get('etag'); if (documentEtag) documentEtags[document.path] = documentEtag;
      const parsed = (this.options.parser ?? parseInternshipMarkdown)(markdown, { sourceId: this.id, document: document.path, sourceUrl: url, season: document.season });
      for (const listing of parsed) {
        const rejection = applicationUrlRejection(listing.applyUrl);
        if (rejection) rejectedApplicationUrls.push({ row: listing.row, url: listing.applyUrl, reason: rejection });
        else rawListings.push(listing);
      }
    }
    if (allUnchanged) {
      return {
        sourceId: this.id,
        outcome: 'unchanged',
        complete: true,
        postings: [],
        rawCount: previous?.lastRawCount ?? previous?.lastRowCount ?? 0,
        contentHash: previous?.contentHash ?? '',
        listings: [],
        notModified: true,
        unchangedReason: 'not_modified',
        checkpoint: {
          ...previous,
          sourceId: this.id,
          documentEtags,
          lastSuccessAt: new Date().toISOString(),
          successfulFetches: previous?.successfulFetches ?? 0,
        },
      };
    }
    // Two rows of one document can share a normalized application URL, so they
    // are one destination. Dropping the repeat keeps the snapshot complete
    // instead of failing an otherwise healthy source; `rawCount` still counts it.
    const postings: SourcedPosting[] = [];
    const identities = new Set<string>();
    let duplicateIdentities = 0;
    for (const listing of rawListings) {
      const posting = markdownListingToSourcedPosting(listing);
      if (identities.has(posting.externalId)) { duplicateIdentities += 1; continue; }
      identities.add(posting.externalId);
      postings.push(posting);
    }
    if (duplicateIdentities) {
      console.log(JSON.stringify({ event: 'markdown_duplicate_identity_dropped', sourceId: this.id, count: duplicateIdentities }));
    }
    const contentHash = createHash('sha256').update(postingProjection(postings)).digest('hex');
    const neutral: SourceSnapshot = {
      sourceId: this.id,
      outcome: contentHash === previous?.contentHash ? 'unchanged' : 'changed',
      complete: true,
      postings,
      rawCount: rawListings.length + rejectedApplicationUrls.length,
      contentHash,
      checkpoint: {
        sourceId: this.id,
        etag: etag ?? previous?.etag,
        documentEtags,
        contentHash,
        lastSuccessAt: new Date().toISOString(),
        successfulFetches: (previous?.successfulFetches ?? 0) + 1,
        lastRowCount: 0,
        lastRawCount: rawListings.length + rejectedApplicationUrls.length,
        activeExternalIds: postings.map((posting) => posting.externalId),
      },
    };
    const processed = processSnapshot(neutral);
    const eligible = processed.listings.filter((listing) => listing.technical !== false);
    neutral.checkpoint.lastRowCount = eligible.length;
    return {
      ...neutral,
      rawRowCount: neutral.rawCount,
      processed,
      listings: eligible,
      ...(rejectedApplicationUrls.length ? { rejectedApplicationUrls } : {}),
      trustedCommunityDiagnostics: {
        rejectedAggregatorRows: rejectedApplicationUrls.filter((item) => item.reason.includes('aggregator')).length,
        survivingAggregatorRows: rawListings.filter((item) => applicationUrlRejection(item.applyUrl)?.includes('aggregator')).length,
        duplicateOccurrenceIds: duplicateIdentities,
      },
      notModified: neutral.outcome === 'unchanged',
    };
  }
}

export const defaultSources: SourceAdapter[] = [
  new GitHubMarkdownAdapter({ id: 'vanshb03-summer-2027', owner: 'vanshb03', repo: 'Summer2027-Internships', documents: [{ path: 'README.md', branch: 'dev', season: 'summer-2027' }, { path: 'OFFSEASON_README.md', branch: 'dev', season: 'offseason-2027' }] }),
  // Keep the legacy source ID so existing checkpoints and occurrences roll
  // forward in place; the upstream repository and season are the 2027 cycle.
  new GitHubMarkdownAdapter({ id: 'simplify-summer-2026', owner: 'SimplifyJobs', repo: 'Summer2027-Internships', documents: [{ path: 'README.md', branch: 'dev', season: 'summer-2027' }, { path: 'README-Off-Season.md', branch: 'dev', season: 'offseason-2027' }] }),
  // zapply-2027 was retired after its upstream switched to a single zapply.jobs
  // redirect host. Historical rows retain the source ID but are no longer polled.
  new GitHubMarkdownAdapter({ id: 'speedyapply-2027-swe', owner: 'speedyapply', repo: '2027-SWE-College-Jobs', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }, { path: 'INTERN_INTL.md', branch: 'main', season: 'summer-2027' }] }),
  new GitHubMarkdownAdapter({ id: 'speedyapply-2027-ai', owner: 'speedyapply', repo: '2027-AI-College-Jobs', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }, { path: 'INTERN_INTL.md', branch: 'main', season: 'summer-2027' }] }),
  new GitHubMarkdownAdapter({ id: 'northwestern-fintech-2027-quant', owner: 'northwesternfintech', repo: '2027QuantInternships', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }], parser: parseQuantInternshipMarkdown }),
  new GitHubMarkdownAdapter({ id: 'canadian-tech-2027', owner: 'negarprh', repo: 'Canadian-Tech-Internships-2027', documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }] })
];
