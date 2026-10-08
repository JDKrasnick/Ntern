import { createHash } from 'node:crypto';
import { providerPostingKey, providerPostingReference } from './posting.js';

export type PostingUrlCorrectionRow = {
  id: string; provider: string; tenant: string; posting_id: string;
  observed_url: string; canonical_url: string; evidence_url: string;
  evidence_hash: string; reviewed_at: string; reviewed_by: string;
};

export function postingUrlCorrectionEvidenceHash(row: PostingUrlCorrectionRow): string {
  return createHash('sha256').update(JSON.stringify({
    provider: row.provider,
    tenant: row.tenant,
    postingId: row.posting_id,
    observedUrl: row.observed_url,
    canonicalUrl: row.canonical_url,
    evidenceUrl: row.evidence_url,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  })).digest('hex');
}

/** Both URLs of a correction must name the reviewed provider tenant, and only
 * the observed one may carry the stale posting id. Anything else is not the
 * exact identity the reviewer recorded, so the plan refuses it. */
export function reviewedUrlCorrection(row: PostingUrlCorrectionRow): { key: string; canonicalUrl: string } {
  const observed = providerPostingReference(row.observed_url);
  const canonical = providerPostingReference(row.canonical_url);
  const evidence = providerPostingReference(row.evidence_url);
  if (observed.provider !== row.provider || observed.tenant?.toLowerCase() !== row.tenant.toLowerCase()
    || observed.postingId?.toLowerCase() !== row.posting_id.toLowerCase()
    || evidence.provider !== row.provider || evidence.tenant?.toLowerCase() !== row.tenant.toLowerCase()
    || evidence.postingId?.toLowerCase() !== row.posting_id.toLowerCase()) {
    throw new Error(`${row.id}: reviewed URL correction does not match its exact provider identity`);
  }
  if (canonical.provider !== row.provider || canonical.tenant?.toLowerCase() !== row.tenant.toLowerCase()
    || !canonical.postingId || canonical.postingId.toLowerCase() === row.posting_id.toLowerCase()) {
    throw new Error(`${row.id}: reviewed URL correction canonical target is not a newer posting of the same provider tenant`);
  }
  if (postingUrlCorrectionEvidenceHash(row) !== row.evidence_hash) {
    throw new Error(`${row.id}: reviewed URL correction evidence hash does not match`);
  }
  return {
    key: providerPostingKey({ provider: row.provider,
      tenant: row.tenant, postingId: row.posting_id }),
    canonicalUrl: row.canonical_url,
  };
}

