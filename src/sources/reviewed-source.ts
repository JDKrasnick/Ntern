/** Provider-neutral admission records shared by present and future ATS sources. */
export type ReviewedProvider = 'greenhouse' | 'lever' | 'ashby' | 'markdown';
export type ReviewedSourceStatus = 'shadow' | 'published';
export type ReviewedEvidenceState =
  | 'ownership-verified'
  | 'pending-review'
  | 'ambiguous-owner'
  | 'custom-host-review'
  | 'expired'
  | 'rejected';

export interface ReviewedBoardIdentity {
  provider: ReviewedProvider;
  /** Provider-issued identity, preserved exactly rather than derived from a company name. */
  boardKey: string;
  apiRegion: 'global' | 'eu';
}

export interface ReviewedApplicationHost {
  host: string;
  /** Required when the host is not the provider's standard application host. */
  justification?: string;
  reviewedAt?: string;
}

export interface SourcePromotionSnapshotEvidence {
  runId: string;
  completedAt: string;
  outcome: 'success_changed' | 'success_unchanged_304' | 'success_unchanged_hash';
  rawRows: number;
  eligibleRows: number;
  withheldRows: number;
  applicationLinksChecked: number;
  applicationLinkFailures: number;
  complete: boolean;
  identityVerified: boolean;
  schemaValid: boolean;
}

/** Durable, human-approved evidence required before a reviewed source may publish. */
export interface SourcePromotionEvidence {
  approvedAt: string;
  approvedBy: string;
  quietBaselineApproved: boolean;
  stableIdentity: boolean;
  stableApplicationHosts: boolean;
  snapshots: SourcePromotionSnapshotEvidence[];
  /** Explicit owner authorization to publish before the normal observation window completes. */
  observationWindowOverride?: {
    reason: string;
    followUpAfter: string;
  };
}

/**
 * Owner declaration that a reviewed board is legitimately empty right now — a
 * seasonal or unused board rather than a parser regression. It waives only the
 * row-count drift guard; identity, schema, host, and link checks still run.
 */
export interface EmptyBoardAcknowledgement {
  /** Owner who re-checked the live board against its reviewed identity. */
  acknowledgedBy: string;
  /** UTC time of that check. */
  acknowledgedAt: string;
  /** Why the empty board is expected; re-read at the next re-verification. */
  reason: string;
}

/**
 * How long an owner's empty-board acknowledgement stays valid. The declaration
 * disables a drift detector, so the owner must re-check the live board inside
 * the same window the provider manifests already allow admission evidence.
 */
export const EMPTY_BOARD_ACKNOWLEDGEMENT_DAYS = 180;

const DAY_MS = 86_400_000;
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Rejection reasons for an owner's empty-board declaration; empty means valid.
 * The stamp is checked against the manifest clock: a future-dated or stale
 * declaration would keep the row-count guard off for a board that may already
 * be drifting, which is the failure this declaration exists to bound rather
 * than to hide.
 */
export function emptyBoardAcknowledgementViolations(acknowledgement: EmptyBoardAcknowledgement, now: Date): string[] {
  const violations: string[] = [];
  if (!acknowledgement.acknowledgedBy.trim()) violations.push('empty-board acknowledgement lacks an owner');
  if (!acknowledgement.reason.trim()) violations.push('empty-board acknowledgement lacks a reason');
  const acknowledgedAt = Date.parse(acknowledgement.acknowledgedAt);
  if (!Number.isFinite(acknowledgedAt)) violations.push('empty-board acknowledgement timestamp is invalid');
  else if (acknowledgedAt > now.getTime() + CLOCK_SKEW_MS) violations.push('empty-board acknowledgement timestamp is in the future');
  else if (Math.floor((now.getTime() - acknowledgedAt) / DAY_MS) > EMPTY_BOARD_ACKNOWLEDGEMENT_DAYS) {
    violations.push(`empty-board acknowledgement is overdue for re-verification (limit ${EMPTY_BOARD_ACKNOWLEDGEMENT_DAYS} days)`);
  }
  return violations;
}

export interface ReviewedSourceRecord {
  id: string;
  company: string;
  identity: ReviewedBoardIdentity;
  careersUrl: string;
  admittedAt: string;
  evidenceState: ReviewedEvidenceState;
  allowedApplicationHosts: ReviewedApplicationHost[];
  status: ReviewedSourceStatus;
  promotionEvidence?: SourcePromotionEvidence;
  /**
   * Set only after the owner confirms the board itself is empty. A zero-row
   * snapshot is then expected rather than treated as parser drift, so the
   * source keeps monitoring and picks up roles when the board refills. The
   * declaration expires after `EMPTY_BOARD_ACKNOWLEDGEMENT_DAYS`; the manifests
   * reject a stale or future-dated stamp so the guard cannot stay off by
   * accident.
   */
  emptyBoardAcknowledged?: EmptyBoardAcknowledgement;
}

export interface EmployerCareersEvidence {
  provider: ReviewedProvider;
  boardKey: string;
  careersUrl: string;
  firstPartyEvidenceUrl: string;
  /** Exact provider board URL found on the employer-controlled page. */
  exactBoardUrl: string;
  evidenceExcerpt: string;
  observedJobUrl: string;
  verifiedAt: string;
  state: ReviewedEvidenceState;
  notes?: string;
}
