import { createHash } from 'node:crypto';
import type { PostingIdentityDecision } from '../types.js';

export const POSTING_IDENTITY_INCIDENT_V2_PREFIX = 'IDENTITY_INCIDENT_V2#';

export function postingIdentityIncidentId(
  sourceId: string,
  externalId: string,
  decision: Extract<PostingIdentityDecision, { status: 'quarantined' }>,
): string {
  const stableDecision = {
    reason: decision.reason,
    reviewFamilyKey: decision.reviewFamilyKey,
    contradictoryEvidence: [...new Set(decision.contradictoryEvidence)].sort(),
  };
  return createHash('sha256')
    .update(`identity-incident-v2:${sourceId}\0${externalId}\0${JSON.stringify(stableDecision)}`)
    .digest('hex');
}
