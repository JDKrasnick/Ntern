import { createHash } from 'node:crypto';

/**
 * Bump whenever the V2 evaluator changes the meaning of a settled decision.
 * The derived version lets shadow discovery reopen existing rows through the
 * normal bounded policy-migration path instead of requiring a manual replay.
 */
export const INGESTION_V2_EVALUATOR_REVISION = 6;

export function ingestionV2AdmissionVersion(
  baseAdmissionVersion: string,
  options: { trustedCommunityAlertsEnabled?: boolean } = {},
): string {
  return createHash('sha256').update(JSON.stringify({
    baseAdmissionVersion,
    evaluatorRevision: INGESTION_V2_EVALUATOR_REVISION,
    trustedCommunityAlertsEnabled: options.trustedCommunityAlertsEnabled ?? false,
  })).digest('hex');
}
