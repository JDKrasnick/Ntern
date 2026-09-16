import { createHash } from 'node:crypto';
import type {
  PostingIdentity,
  PostingIdentityDecision,
  PostingIdentityEvidenceKind,
  PostingProvider,
  ProviderPostingEvidence,
} from '../types.js';
import {
  buildPostingIdentity,
  canonicalizePostingUrl,
  providerPostingAlias,
  providerPostingReference,
  type ProviderPostingReference,
} from './posting.js';
import { reviewedProviderEvidenceError, unscopedGreenhouseEmbedPostingId } from './reviewed-provider.js';

export const POSTING_IDENTITY_CONTRACT_VERSION = 1;
export const REVIEWED_CANONICAL_URL_CONTRACT_ID = 'reviewed-canonical-url';

export interface ReviewedCanonicalUrlEvidence {
  canonicalUrl: string;
  contractId: string;
  contractVersion: number;
  approvalReference: string;
  evidenceHash: string;
  observedAt: string;
  expiresAt?: string;
}

export interface PostingIdentityRegistryInput {
  sourceId: string;
  externalId: string;
  applicationUrl: string;
  observedAt: string;
  observedUrls?: string[];
  finalOfficialUrl?: string;
  providerEvidence?: ProviderPostingEvidence;
  /** References already checked against a reviewed source/checkpoint. */
  reviewedProviderReferences?: ProviderPostingReference[];
  reviewedCanonicalUrl?: ReviewedCanonicalUrlEvidence;
  employerId?: string;
  employerRequisitionId?: string;
  employerRequisitionAuthoritative?: boolean;
  authoritativeEmployerRequisitions?: Array<{ employerId: string; requisitionId: string }>;
  previousDecision?: PostingIdentityDecision;
}

export interface PostingIdentityRegistryResult {
  decision: PostingIdentityDecision;
  identity?: PostingIdentity;
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function reviewedCanonicalUrlEvidenceHash(canonicalUrlValue: string, contractVersion = POSTING_IDENTITY_CONTRACT_VERSION) {
  return digest({
    canonicalUrl: canonicalUrl(canonicalUrlValue),
    contractId: REVIEWED_CANONICAL_URL_CONTRACT_ID,
    contractVersion,
  });
}

function canonicalUrl(value: string) {
  try { return canonicalizePostingUrl(value); }
  catch { return value.trim(); }
}

/** Sanitized URL-family signature: no values, fragments, credentials, or free text. */
export function postingReviewFamily(input: string): string {
  try {
    const url = new URL(input);
    const structural = new Set(['apply', 'application', 'careers', 'detail', 'embed', 'job', 'job_app', 'jobs', 'position', 'search']);
    const path = url.pathname.split('/').filter(Boolean).map((segment) => {
      if (/^\d+$/u.test(segment)) return ':number';
      if (/^[a-f0-9]{8}-[a-f0-9-]{27,}$/iu.test(segment)) return ':uuid';
      const normalized = segment.toLowerCase().replace(/[^a-z0-9_~-]/gu, '').slice(0, 32);
      return structural.has(normalized) ? normalized : ':segment';
    }).join('/');
    const queryNames = [...new Set([...url.searchParams.keys()].map((key) => key.toLowerCase()))].sort();
    return `${url.hostname.toLowerCase().replace(/^www\./u, '')}/${path}?${queryNames.join('&')}`;
  } catch {
    return 'invalid-url';
  }
}

export function stableSourceOccurrenceJobId(sourceId: string, externalId: string) {
  return createHash('sha256').update(`source-occurrence-v1:${sourceId}\0${externalId}`).digest('hex').slice(0, 32);
}

function unconfirmed(input: PostingIdentityRegistryInput, reason: Extract<PostingIdentityDecision, { status: 'unconfirmed' }>['reason']): PostingIdentityRegistryResult {
  return { decision: { status: 'unconfirmed', reason, reviewFamilyKey: postingReviewFamily(input.applicationUrl), observedAt: input.observedAt } };
}

function quarantined(
  input: PostingIdentityRegistryInput,
  reason: Extract<PostingIdentityDecision, { status: 'quarantined' }>['reason'],
  evidence: string[],
): PostingIdentityRegistryResult {
  return { decision: {
    status: 'quarantined', reason, contradictoryEvidence: [...new Set(evidence)].sort(),
    reviewFamilyKey: postingReviewFamily(input.applicationUrl), observedAt: input.observedAt,
  } };
}

function contractFor(provider: Exclude<PostingProvider, 'unknown'>) {
  return { contractId: `posting-provider-${provider}`, contractVersion: POSTING_IDENTITY_CONTRACT_VERSION, approvalReference: `registry:${provider}:v${POSTING_IDENTITY_CONTRACT_VERSION}` };
}

function claimableIdentity(identity: PostingIdentity, exactKey: string, evidenceKind: PostingIdentityEvidenceKind): PostingIdentity {
  const aliases = [...new Map(identity.aliases.filter((alias) => evidenceKind === 'immutable-provider-id'
    ? alias.value === exactKey && (alias.kind === 'provider-posting' || alias.kind === 'provider-route')
    : evidenceKind === 'authoritative-employer-requisition'
      ? alias.value === exactKey && alias.kind === 'employer-requisition'
      : alias.value === exactKey).map((alias) => [alias.value, alias])).values()];
  return { ...identity, aliases };
}

function confirmed(
  input: PostingIdentityRegistryInput,
  exactKey: string,
  evidenceKind: PostingIdentityEvidenceKind,
  metadata: { provider?: Exclude<PostingProvider, 'unknown'>; tenant?: string; employerId?: string; contractId: string; contractVersion: number; approvalReference: string; evidenceHash: string },
  identity: PostingIdentity,
): PostingIdentityRegistryResult {
  // Only the reviewed exact anchor is claimable across sources. Application
  // URLs remain useful presentation/lookup data, but provider and requisition
  // postings can legitimately reuse them; claiming those URLs would let a
  // weaker syntactic match bridge two different immutable IDs.
  return { decision: {
    status: 'confirmed', exactKey, evidenceKind, ...metadata, observedAt: input.observedAt,
  }, identity: claimableIdentity(identity, exactKey, evidenceKind) };
}

function stale(expiresAt: string | undefined, observedAt: string) {
  return Boolean(expiresAt && Date.parse(expiresAt) <= Date.parse(observedAt));
}

function previousProviderReference(
  decision: PostingIdentityDecision | undefined,
  urls: string[],
): ProviderPostingReference | undefined {
  if (decision?.status !== 'confirmed' || decision.evidenceKind !== 'immutable-provider-id') return undefined;
  for (const url of urls) {
    try {
      const reference = providerPostingReference(url);
      if (providerPostingAlias(reference) === decision.exactKey) return reference;
    } catch { /* An invalid alias cannot preserve a confirmed provider identity. */ }
  }
  return undefined;
}

/**
 * Provider-neutral exact-identity registry. Syntactic URL normalization is not
 * evidence: only checked provider routes, authoritative requisitions, or an
 * immutable reviewed canonical-URL approval can return `confirmed`.
 */
export function resolvePostingIdentityDecision(input: PostingIdentityRegistryInput): PostingIdentityRegistryResult {
  const urls = [input.applicationUrl, ...(input.providerEvidence?.urls ?? []), ...(input.observedUrls ?? []), ...(input.finalOfficialUrl ? [input.finalOfficialUrl] : [])];
  if (input.providerEvidence) {
    const error = reviewedProviderEvidenceError(input.providerEvidence);
    if (error) return quarantined(input, 'evidence-contract-mismatch', [error]);
    if ((input.providerEvidence.contractVersion !== undefined && input.providerEvidence.contractVersion !== POSTING_IDENTITY_CONTRACT_VERSION)
      || (input.providerEvidence.contractId !== undefined && input.providerEvidence.contractId !== `posting-provider-${input.providerEvidence.provider}`)) {
      return quarantined(input, 'evidence-contract-mismatch', [
        `${input.providerEvidence.contractId ?? 'missing'}@${input.providerEvidence.contractVersion ?? 'missing'}`,
        `posting-provider-${input.providerEvidence.provider}@${POSTING_IDENTITY_CONTRACT_VERSION}`,
      ]);
    }
  }

  const requisitions = [
    ...(input.employerRequisitionAuthoritative && input.employerId && input.employerRequisitionId?.trim()
      ? [{ employerId: input.employerId, requisitionId: input.employerRequisitionId.trim() }]
      : []),
    ...(input.authoritativeEmployerRequisitions ?? []),
  ].map((item) => ({ employerId: item.employerId.trim(), requisitionId: item.requisitionId.trim().toLowerCase() }))
    .filter((item) => item.employerId && item.requisitionId);
  const uniqueRequisitions = [...new Map(requisitions.map((item) => [`${item.employerId}\0${item.requisitionId}`, item])).values()];
  const employerScopes = new Set(uniqueRequisitions.map((item) => item.employerId));
  if (employerScopes.size > 1) return quarantined(input, 'employer-scope-mismatch', [...employerScopes]);
  if (uniqueRequisitions.length > 1) {
    return quarantined(input, 'multiple-authoritative-requisitions', uniqueRequisitions.map((item) => `requisition:${item.employerId}:${item.requisitionId}`));
  }
  const requisition = uniqueRequisitions[0];

  const explicit = input.providerEvidence ? [{
    provider: input.providerEvidence.provider,
    tenant: input.providerEvidence.tenant.toLowerCase(),
    postingId: input.providerEvidence.postingId.toLowerCase(),
  } satisfies ProviderPostingReference] : [];
  // A provider route in an application URL is a scoped, provider-owned key
  // (provider + tenant + posting id), so it is claimed like any other exact
  // reference. Greenhouse and Lever were previously excluded on the theory that
  // their URLs could be reused by different postings; measured across the live
  // catalog the only sharing is the same posting ingested from several lists
  // (one Lyft `?gh_jid=` role in three lists), and the guards below stay
  // fail-closed: references that disagree on scope, or that name two different
  // ids, quarantine the posting instead of bridging it. `unknown` stays out
  // because it carries no posting id at all.
  const routeReferences = urls.map((url) => {
    try { return providerPostingReference(url); }
    catch { return { provider: 'unknown' as const }; }
  }).filter((reference) => reference.provider !== 'unknown');
  const references = [...explicit, ...(input.reviewedProviderReferences ?? []), ...routeReferences]
    .filter((reference): reference is ProviderPostingReference & { provider: Exclude<PostingProvider, 'unknown'>; postingId: string } => reference.provider !== 'unknown' && Boolean(reference.postingId))
    .map((reference) => ({ ...reference, tenant: reference.tenant?.toLowerCase(), postingId: reference.postingId.toLowerCase() }));
  const exactReferences = [...new Map(references.map((reference) => [providerPostingAlias(reference)!, reference])).values()];
  const scopes = new Set(exactReferences.map((reference) => `${reference.provider}:${reference.tenant ?? '-'}`));
  if (scopes.size > 1) return quarantined(input, 'provider-scope-mismatch', [...scopes]);
  if (exactReferences.length > 1) return quarantined(input, 'multiple-immutable-provider-postings', exactReferences.map((reference) => providerPostingAlias(reference)!));

  const reference = exactReferences[0];
  if (reference) {
    const exactKey = providerPostingAlias(reference)!;
    if (input.previousDecision?.status === 'confirmed' && input.previousDecision.exactKey === exactKey) {
      const identity = buildPostingIdentity({ ...input, reviewedProviderReferences: [reference] });
      return { decision: input.previousDecision, identity: claimableIdentity(identity, exactKey, input.previousDecision.evidenceKind) };
    }
    const evidenceExpiresAt = input.providerEvidence?.expiresAt;
    if (stale(evidenceExpiresAt, input.observedAt)) {
      return unconfirmed(input, 'stale-evidence');
    }
    const contract = contractFor(reference.provider);
    const evidenceHash = input.providerEvidence?.evidenceHash ?? digest({ exactKey, urls: urls.map(canonicalUrl).sort(), contract });
    const identity = buildPostingIdentity({ ...input, reviewedProviderReferences: [reference] });
    return confirmed(input, exactKey, 'immutable-provider-id', {
      provider: reference.provider, ...(reference.tenant ? { tenant: reference.tenant } : {}), ...contract,
      approvalReference: input.providerEvidence?.approvalReference ?? contract.approvalReference,
      evidenceHash,
    }, identity);
  }

  if (requisition) {
    const exactKey = `requisition:${requisition.employerId}:${requisition.requisitionId}`;
    const contract = { contractId: 'authoritative-employer-requisition', contractVersion: POSTING_IDENTITY_CONTRACT_VERSION, approvalReference: `employer:${requisition.employerId}` };
    const identity = buildPostingIdentity({
      ...input,
      employerId: requisition.employerId,
      employerRequisitionId: requisition.requisitionId,
      employerRequisitionAuthoritative: true,
    });
    return confirmed(input, exactKey, 'authoritative-employer-requisition', { employerId: requisition.employerId, ...contract, evidenceHash: digest({ exactKey, contract }) }, identity);
  }

  const reviewedUrl = input.reviewedCanonicalUrl;
  if (reviewedUrl) {
    const expectedUrl = canonicalUrl(reviewedUrl.canonicalUrl);
    const observedCanonicalUrls = new Set(urls.map(canonicalUrl));
    if (reviewedUrl.contractId !== REVIEWED_CANONICAL_URL_CONTRACT_ID
      || reviewedUrl.contractVersion !== POSTING_IDENTITY_CONTRACT_VERSION
      || !observedCanonicalUrls.has(expectedUrl)
      || reviewedUrl.evidenceHash !== reviewedCanonicalUrlEvidenceHash(expectedUrl, reviewedUrl.contractVersion)) {
      return quarantined(input, 'evidence-contract-mismatch', [reviewedUrl.contractId, reviewedUrl.evidenceHash]);
    }
    if (stale(reviewedUrl.expiresAt, input.observedAt)) {
      const exactKey = `url:${expectedUrl}`;
      if (input.previousDecision?.status === 'confirmed' && input.previousDecision.exactKey === exactKey) {
        const identity = buildPostingIdentity({ ...input, finalOfficialUrl: expectedUrl });
        return { decision: input.previousDecision, identity: claimableIdentity(identity, exactKey, input.previousDecision.evidenceKind) };
      }
      return unconfirmed(input, 'stale-evidence');
    }
    const exactKey = `url:${expectedUrl}`;
    return confirmed(input, exactKey, 'reviewed-canonical-url', {
      contractId: reviewedUrl.contractId, contractVersion: reviewedUrl.contractVersion,
      approvalReference: reviewedUrl.approvalReference, evidenceHash: reviewedUrl.evidenceHash,
    }, buildPostingIdentity({ ...input, finalOfficialUrl: expectedUrl }));
  }

  const retainedReference = previousProviderReference(input.previousDecision, urls);
  if (retainedReference && input.previousDecision?.status === 'confirmed') {
    const identity = buildPostingIdentity({ ...input, reviewedProviderReferences: [retainedReference] });
    return {
      decision: input.previousDecision,
      identity: claimableIdentity(identity, input.previousDecision.exactKey, input.previousDecision.evidenceKind),
    };
  }

  if (urls.some((url) => unscopedGreenhouseEmbedPostingId(url))) return unconfirmed(input, 'under-scoped-id');
  const recognizable = urls.some((url) => {
    try { return providerPostingReference(url).provider !== 'unknown'; }
    catch { return false; }
  });
  return unconfirmed(input, recognizable ? 'insufficient-exact-evidence' : 'unrecognized-url-family');
}
