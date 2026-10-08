import { providerPostingKey, providerPostingReference } from '../src/identity/posting.js';
import { reviewedUrlCorrection, type PostingUrlCorrectionRow } from '../src/identity/source-corrections.js';
import type { D1Database } from './types.js';

/** Only an immutable, evidence-validated exact provider correction may re-anchor identity. */
export async function reviewedIdentityApplicationUrl(db: D1Database, applyUrl: string): Promise<string | undefined> {
  const reference = providerPostingReference(applyUrl);
  if (reference.provider === 'unknown' || !reference.tenant || !reference.postingId) return undefined;
  const rows = (await db.prepare(`SELECT id, provider, tenant, posting_id, observed_url, canonical_url,
    evidence_url, evidence_hash, reviewed_at, reviewed_by FROM posting_url_corrections
    WHERE provider = ? AND tenant = ? AND posting_id = ? LIMIT 2`)
    .bind(reference.provider, reference.tenant.toLowerCase(), reference.postingId.toLowerCase())
    .all<PostingUrlCorrectionRow>()).results;
  if (!rows.length) return undefined;
  if (rows.length !== 1) throw new Error('Multiple reviewed posting URL corrections');
  const correction = reviewedUrlCorrection(rows[0]!);
  if (correction.key !== providerPostingKey({ provider: reference.provider, tenant: reference.tenant,
    postingId: reference.postingId })) throw new Error('Reviewed posting URL correction identity mismatch');
  return correction.canonicalUrl;
}
