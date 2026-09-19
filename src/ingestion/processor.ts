import { earlyCareerRequirements, hasLifecycleTitleSignal, htmlToText, inferSeason, inferWorkMode } from '../core/early-career.js';
import { assessTechnicalRole, technicalScopeFor } from '../core/filters.js';
import { parseCompensation } from '../core/normalize.js';
import { isTruncatedTitle, repairTitle } from '../core/role-title.js';
import { buildInternshipIdentity } from '../identity/enrichment.js';
import { canonicalCompanyKey } from '../core/normalize.js';
import { metadataCompleteness } from '../catalog-admission.js';
import { normalizeListing, normalizeLocations, locationSummary } from '../catalog-quality.js';
import { applicationUrlRejection } from '../sources/quality.js';
import { providerPostingReference } from '../identity/posting.js';
import { extractPostingMetadataEvidence } from '../role-metadata.js';
import { metadataDescriptionText } from '../core/metadata-text.js';
import { normalizeExactPostingDescription } from '../shadow-extraction.js';
import type {
  JobRequirements,
  PostingDecision,
  ProcessedListing,
  ProcessedSnapshot,
  SourceSnapshot,
  SourcedPosting,
} from '../types.js';

// Source preprocessing can change independently of the shared API/page parser.
// Revisit source snapshots without invalidating complete API acquisitions.
export const SOURCE_METADATA_PROCESSING_REVISION = 2;

function markdownToText(value: string): string {
  return htmlToText(value
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[*_`>#-]/g, ' '));
}

function contentText(posting: SourcedPosting): string {
  return posting.content.map((part) => {
    if (part.format === 'html') return htmlToText(part.value);
    if (part.format === 'markdown') return markdownToText(part.value);
    return htmlToText(part.value);
  }).join(' ').replace(/\s+/g, ' ').trim();
}

function requirements(posting: SourcedPosting, content: string): JobRequirements {
  const inferred = earlyCareerRequirements(content);
  return {
    requiresUsCitizenship: posting.declaredRequirements?.requiresUsCitizenship ?? inferred.requiresUsCitizenship,
    advancedDegreeRequired: posting.declaredRequirements?.advancedDegreeRequired ?? inferred.advancedDegreeRequired,
  };
}

function withheldReason(url: string): PostingDecision['reason'] | undefined {
  const rejection = applicationUrlRejection(url);
  if (!rejection) return undefined;
  return rejection.includes('aggregator') ? 'aggregator-destination' : 'invalid-application-url';
}

function destinationProviderReference(applyUrl: string) {
  const reviewed = providerPostingReference(applyUrl);
  if (reviewed.provider !== 'unknown') return reviewed;
  try {
    const url = new URL(applyUrl);
    const greenhouseId = url.searchParams.get('gh_jid');
    if (greenhouseId && /^\d+$/u.test(greenhouseId)) return { provider: 'greenhouse' as const, postingId: greenhouseId };
  } catch { /* Invalid URLs are rejected before this evidence is used. */ }
  return reviewed;
}

export function processPosting(
  posting: SourcedPosting,
  employerTitles: readonly string[] = [],
): { listing?: ProcessedListing; decision: PostingDecision } {
  if (posting.sourceState === 'prospect') {
    return { decision: { externalId: posting.externalId, outcome: 'filtered', reason: 'prospect' } };
  }
  const sourceTitle = htmlToText(posting.title);
  const title = repairTitle(sourceTitle, employerTitles);
  const content = contentText(posting);
  const shadowDescription = posting.content.map(part => metadataDescriptionText(part.format === 'markdown'
    ? part.value.replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/[*`>#]/gu, ' ')
    : part.value)).join('\n');
  if (posting.lifecycleAuthority !== 'source' && posting.lifecycleAuthority !== 'posting' && !hasLifecycleTitleSignal(title)) {
    return { decision: { externalId: posting.externalId, outcome: 'filtered', reason: 'not-early-career' } };
  }
  const company = htmlToText(posting.employer.name);
  const sourceLocations = posting.locations.map(htmlToText).filter(Boolean);
  const locations = normalizeLocations(sourceLocations);
  const location = locationSummary(locations);
  const titleSeason = inferSeason(title, '');
  const season = titleSeason !== 'ongoing' ? titleSeason : posting.seasonHint ?? inferSeason('', content);
  const classificationTitle = [title, ...(posting.classificationTags ?? []).map(htmlToText)].filter(Boolean).join(' ');
  const assessment = assessTechnicalRole({ company, title: classificationTitle, location, season }, content);
  const urlReason = withheldReason(posting.applyUrl);
  if (urlReason) {
    return { decision: { externalId: posting.externalId, outcome: 'withheld', reason: urlReason } };
  }
  // A structured provider field is authoritative; prose only fills the gap when
  // the source declares nothing usable.
  const workMode = inferWorkMode(posting.declaredWorkMode) ?? inferWorkMode(`${location} ${content}`);
  const destinationReference = destinationProviderReference(posting.applyUrl);
  const listing: ProcessedListing = normalizeListing({
    sourceId: posting.sourceId,
    ...(posting.provenance ? { provenance: posting.provenance } : {}),
    externalId: posting.externalId,
    document: posting.document ?? posting.externalId,
    sourceUrl: posting.sourceUrl,
    row: posting.row ?? 1,
    company,
    title,
    location,
    locations,
    season,
    ...(titleSeason === 'ongoing' && posting.seasonHintAuthority === 'source-default'
      ? { seasonSource: 'source-default' as const }
      : {}),
    applyUrl: posting.applyUrl,
    ...(posting.providerEvidence ? { providerEvidence: posting.providerEvidence } : {}),
    compensation: parseCompensation(posting.compensationText ?? content),
    requirements: requirements(posting, content),
    state: posting.sourceState,
    ...(posting.publishedAt ? { postedAt: posting.publishedAt } : {}),
    ...(posting.providerTimestamp ? { providerTimestamp: posting.providerTimestamp } : {}),
    ...(workMode ? { workMode } : {}),
    metadataEvidence: extractPostingMetadataEvidence({
      artifact: {
        title,
        text: shadowDescription,
        ...(posting.compensationText ? { compensationText: posting.compensationText } : {}),
        ...(posting.compensationBands?.length ? { compensationBands: posting.compensationBands } : {}),
        locations: sourceLocations,
        ...(posting.declaredWorkMode ? { workMode: posting.declaredWorkMode } : workMode ? { workMode } : {}),
        ...(posting.providerTimestamp?.semantics === 'published' ? { publishedAt: posting.providerTimestamp.value }
          : posting.publishedAt ? { publishedAt: posting.publishedAt } : {}),
        ...(posting.providerTimestamp?.semantics === 'updated' ? { updatedAt: posting.providerTimestamp.value } : {}),
      },
      sourceClass: posting.provenance === 'reviewed-community' ? 'reviewed-community'
        : posting.provenance === 'official-structured' ? 'official-json-ld' : 'official-ats',
      sourceId: posting.sourceId,
      sourceUrl: posting.sourceUrl,
      observedAt: posting.fetchedAt,
      exactPosting: true,
    }),
    internshipIdentity: buildInternshipIdentity({
      sourceId: posting.sourceId,
      sourceUrl: posting.sourceUrl,
      observedAt: posting.fetchedAt,
      company,
      companyId: posting.employer.id,
      title,
      location,
      season,
      seasonEvidenceStatus: titleSeason !== 'ongoing' || posting.seasonHintAuthority === 'posting'
        ? 'explicit'
        : season !== 'ongoing' ? 'inferred' : 'unspecified',
      content,
      ...(workMode ? { workMode } : {}),
    }),
    fetchedAt: posting.fetchedAt,
    ...(posting.providerIdentity && ['greenhouse', 'lever', 'ashby'].includes(posting.providerIdentity.provider)
      ? { shadowContentHash: normalizeExactPostingDescription(title, shadowDescription).contentHash }
      : {}),
    technical: assessment.technical,
    ...(technicalScopeFor({ company, title: classificationTitle, location, season }, content) ? { technicalScope: technicalScopeFor({ company, title: classificationTitle, location, season }, content) } : {}),
    ...(title === sourceTitle ? {} : { titleRepaired: true }),
    providerIdentity: {
      provider: posting.providerIdentity?.provider
        ?? (destinationReference.provider !== 'unknown' ? destinationReference.provider
          : posting.sourceId.startsWith('greenhouse-') ? 'greenhouse'
          : posting.sourceId.startsWith('lever-') ? 'lever'
            : posting.sourceId.startsWith('ashby-') ? 'ashby'
              : posting.provenance === 'official-structured' ? 'structured'
                : posting.provenance === 'employer-submitted' ? 'employer-submission' : 'github'),
      sourceId: posting.sourceId,
      sourceUrl: posting.sourceUrl,
      ...(posting.employer.labelOrigin !== 'inherited' || posting.employer.inheritance === 'same-tenant'
        ? { employerScope: `employer:${canonicalCompanyKey(company)}` } : {}),
      ...(posting.providerIdentity?.tenant ? { tenant: posting.providerIdentity.tenant }
        : destinationReference.tenant ? { tenant: destinationReference.tenant } : {}),
      postingId: destinationReference.postingId ?? posting.externalId,
    },
    employerEvidence: {
      authority: posting.employer.authority,
    },
    metadataCompleteness: metadataCompleteness({
      title: sourceTitle,
      locations: sourceLocations,
      titleRepaired: title !== sourceTitle,
    }),
    ...(posting.employer.labelOrigin ? { employerLabelOrigin: posting.employer.labelOrigin } : {}),
    ...(posting.employer.inheritance ? { employerInheritance: posting.employer.inheritance } : {}),
  });
  // A non-technical early-career role is still worth keeping: it is persisted,
  // stays out of every catalog index and alert, and remains available if the
  // catalog's scope ever widens.
  return assessment.technical
    ? { listing, decision: { externalId: posting.externalId, outcome: 'included', reason: 'source-policy' } }
    : { listing, decision: { externalId: posting.externalId, outcome: 'shelved', reason: 'nontechnical' } };
}

export function processSnapshot(snapshot: SourceSnapshot): ProcessedSnapshot {
  const listings: ProcessedListing[] = [];
  const decisions: PostingDecision[] = [];
  // A source that truncates one row usually publishes the same role whole
  // elsewhere, so whole titles for an employer repair that employer's cut ones.
  const employerTitles = new Map<string, string[]>();
  for (const posting of snapshot.postings) {
    if (isTruncatedTitle(posting.title)) continue;
    const key = htmlToText(posting.employer.name).toLowerCase();
    const title = htmlToText(posting.title);
    // Appending in place keeps one array per employer: copying the accumulated
    // list on every row is quadratic for a single-employer ATS board.
    const titles = employerTitles.get(key);
    if (titles) titles.push(title);
    else employerTitles.set(key, [title]);
  }
  for (const posting of snapshot.postings) {
    const result = processPosting(posting, employerTitles.get(htmlToText(posting.employer.name).toLowerCase()) ?? []);
    decisions.push(result.decision);
    if (result.listing) listings.push(result.listing);
  }
  const count = (outcome: PostingDecision['outcome']) => decisions.filter((decision) => decision.outcome === outcome).length;
  const shelved = count('shelved');
  return {
    listings,
    decisions,
    counts: {
      raw: snapshot.rawCount,
      valid: snapshot.postings.length,
      eligible: listings.length - shelved,
      shelved,
      filtered: count('filtered'),
      withheld: count('withheld'),
    },
  };
}
