import { api, ApiError, authenticatedRead } from "./api";

export type EmployerVerificationState =
  | "challenge-pending"
  | "review-pending"
  | "verified"
  | "rejected"
  | "expired"
  | "revoked";
export type EmployerSourceState =
  | "pending-review"
  | "shadow"
  | "active"
  | "stale"
  | "disconnected"
  | "quarantined"
  | "rejected";
export type EmployerSubmissionState =
  | "draft"
  | "pending-review"
  | "published"
  | "rejected"
  | "quarantined"
  | "closed";
export type EmployerProposalState = "pending-review" | "accepted" | "rejected";
export type EmployerWorkspaceSection =
  | "verification"
  | "members"
  | "sources"
  | "metadata"
  | "submissions";

export type EmployerOrganization = {
  organizationId: string;
  name: string;
  domain: string;
  role: "owner" | "editor";
  verificationState: EmployerVerificationState;
  verificationReason?: string;
  verificationExpiresAt?: string;
  activeChallengeId?: string;
  challengeToken?: string;
};
export type EmployerMember = {
  membershipId: string;
  userId?: string;
  email: string;
  role: "owner" | "editor";
  state?: "active" | "invited" | "expired" | "revoked";
  reason?: string;
};
export type EmployerSource = {
  sourceId: string;
  provider: "greenhouse" | "lever" | "ashby" | "json-ld" | "sitemap" | "embedded";
  url: string;
  state: EmployerSourceState;
  reason?: string;
  lastSuccessfulAt?: string;
};
export type EmployerMetadataProposal = {
  proposalId: string;
  jobId: string;
  field: string;
  originalValue?: string;
  proposedValue: string;
  state: EmployerProposalState;
  reason?: string;
};
export type EmployerSubmission = {
  submissionId: string;
  title: string;
  state: EmployerSubmissionState;
  reason?: string;
  updatedAt?: string;
};
export type EmployerWorkspace = {
  enabled: boolean;
  organization?: EmployerOrganization;
  members: EmployerMember[];
  sources: EmployerSource[];
  metadataProposals: EmployerMetadataProposal[];
  submissions: EmployerSubmission[];
  message?: string;
};

export type EmployerStateExplanation = {
  label: string;
  tone: "neutral" | "positive" | "warning" | "danger";
  reason?: string;
  nextAction?: string;
};

export const employerWorkspaceSections: ReadonlyArray<{
  id: EmployerWorkspaceSection;
  label: string;
  description: string;
}> = [
  { id: "verification", label: "Verification", description: "Confirm your organization and publishing access." },
  { id: "members", label: "Members", description: "Manage owners, editors, and invitations." },
  { id: "sources", label: "Sources", description: "Connect and monitor official careers sources." },
  { id: "metadata", label: "Metadata", description: "Propose attributed corrections to catalog fields." },
  { id: "submissions", label: "Submissions", description: "Submit structured roles for review." },
] as const;

export function employerRouteFromUrl(url: string | undefined): EmployerWorkspaceSection | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, "https://internnotifs.invalid");
    const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (segments[0] !== "employer" || segments.length > 2) return undefined;
    const requested = segments[1];
    return employerWorkspaceSections.some(({ id }) => id === requested)
      ? requested as EmployerWorkspaceSection
      : "verification";
  } catch {
    return undefined;
  }
}

export function employerStateExplanation(
  state: EmployerVerificationState | EmployerSourceState | EmployerSubmissionState | EmployerProposalState | EmployerMember["state"],
  reason?: string,
): EmployerStateExplanation {
  const explanations: Record<string, Omit<EmployerStateExplanation, "reason"> & { defaultReason?: string }> = {
    "challenge-pending": { label: "Challenge pending", tone: "warning", nextAction: "Publish the provided token, then check verification." },
    "review-pending": { label: "In review", tone: "neutral", nextAction: "No action is needed while the review is in progress." },
    verified: { label: "Verified", tone: "positive" },
    rejected: { label: "Rejected", tone: "danger", defaultReason: "The submitted evidence did not pass review.", nextAction: "Address the reason below, then submit again." },
    expired: { label: "Expired", tone: "danger", defaultReason: "The verification or invitation reached its expiry date.", nextAction: "Start a new verification challenge or invitation." },
    revoked: { label: "Revoked", tone: "danger", defaultReason: "Access was withdrawn after a trust or ownership review.", nextAction: "Contact Ntern support before reconnecting or publishing." },
    "pending-review": { label: "Pending review", tone: "neutral", nextAction: "No action is needed while the review is in progress." },
    shadow: { label: "Shadow monitoring", tone: "neutral", nextAction: "Wait for two healthy snapshots and maintainer promotion." },
    active: { label: "Active", tone: "positive" },
    stale: { label: "Stale", tone: "warning", defaultReason: "Recent complete updates have not arrived on schedule.", nextAction: "Confirm the source still publishes complete, current role data." },
    disconnected: { label: "Disconnected", tone: "danger", defaultReason: "Ntern cannot reach or validate this source.", nextAction: "Check the exact source URL and reconnect it." },
    quarantined: { label: "Quarantined", tone: "danger", defaultReason: "Publishing paused after a trust or destination check.", nextAction: "Resolve the trust or destination issue shown below, then request review." },
    draft: { label: "Draft", tone: "neutral", nextAction: "Complete the required fields, then submit for review." },
    published: { label: "Published", tone: "positive" },
    closed: { label: "Closed", tone: "neutral" },
    accepted: { label: "Accepted", tone: "positive" },
    invited: { label: "Invitation sent", tone: "neutral", nextAction: "Ask the recipient to accept before the invitation expires." },
  };
  const { defaultReason, ...explanation } = explanations[state ?? "active"] ?? { label: String(state), tone: "neutral" as const };
  return { ...explanation, reason: reason ?? defaultReason };
}

export function sourceConnectionPayload(url: string) {
  return { url: url.trim() };
}

export function metadataProposalPayload(jobId: string, field: string, proposedValue: string) {
  return { jobId: jobId.trim(), field: field.trim(), proposedValue: proposedValue.trim() };
}

export function directSubmissionPayload(input: {
  company: string;
  title: string;
  programType: string;
  discipline: string;
  location: string;
  workMode: string;
  season: string;
  deadline: string;
  deadlineTimezone?: string;
  workAuthorization: string;
  applicationUrl: string;
  privateReviewNote?: string;
}) {
  return { ...Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value?.trim()]).filter(([, value]) => value !== "")), submit: true };
}

const organizationPath = (organizationId: string) => `/employer/organizations/${encodeURIComponent(organizationId)}`;
type EmployerReadOptions = { onToken?: (token: string) => void };
let employerMutationSequence = 0;
const employerMutationKeys = new Map<string, string>();
function mutation(key: string, body?: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Idempotency-Key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function mutate<T>(path: string, token: string, body?: unknown, method = "POST"): Promise<T> {
  const signature = `${method}:${path}:${JSON.stringify(body ?? null)}`;
  let key = employerMutationKeys.get(signature);
  if (!key) {
    employerMutationSequence += 1;
    key = `employer-web-${Date.now()}-${employerMutationSequence}`;
    employerMutationKeys.set(signature, key);
  }
  try {
    const result = await api<T>(path, token, mutation(key, body, method));
    employerMutationKeys.delete(signature);
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status !== undefined && error.status < 500) employerMutationKeys.delete(signature);
    throw error;
  }
}

export const employerApi = {
  organizations: (options?: EmployerReadOptions) => authenticatedRead<{ organizations: EmployerOrganization[] }>("/employer/organizations", options),
  organization: (organizationId: string, options?: EmployerReadOptions) => authenticatedRead<{
    organization: EmployerOrganization;
    members?: EmployerMember[];
    sources?: EmployerSource[];
    proposals?: EmployerMetadataProposal[];
    submissions?: EmployerSubmission[];
  }>(organizationPath(organizationId), options),
  members: (organizationId: string, options?: EmployerReadOptions) => authenticatedRead<{ members: EmployerMember[] }>(`${organizationPath(organizationId)}/members`, options),
  invitations: (organizationId: string, options?: EmployerReadOptions) => authenticatedRead<{ invitations: EmployerMember[] }>(`${organizationPath(organizationId)}/invitations`, options),
  sources: (organizationId: string, options?: EmployerReadOptions) => authenticatedRead<{ sources: EmployerSource[] }>(`${organizationPath(organizationId)}/sources`, options),
  proposals: (organizationId: string, options?: EmployerReadOptions) => authenticatedRead<{ proposals: EmployerMetadataProposal[] }>(`${organizationPath(organizationId)}/proposals`, options),
  submissions: (organizationId: string, options?: EmployerReadOptions) => authenticatedRead<{ submissions: EmployerSubmission[] }>(`${organizationPath(organizationId)}/submissions`, options),
  claim: (token: string, input: { name: string; domain: string }) =>
    mutate<{ organization: EmployerOrganization }>("/employer/organizations", token, input),
  createChallenge: (token: string, organizationId: string, method: "email-domain" | "dns-txt" | "well-known") =>
    mutate<{ organization?: EmployerOrganization; challenge: { id: string; token?: string }; token?: string; replayed?: boolean }>(`${organizationPath(organizationId)}/challenges`, token, { method }),
  verifyChallenge: (token: string, organizationId: string, challengeId: string, challengeToken: string) =>
    mutate<{ organization: EmployerOrganization; replayed?: boolean }>(`${organizationPath(organizationId)}/challenges/${encodeURIComponent(challengeId)}/verify`, token, { token: challengeToken }),
  inviteMember: (token: string, organizationId: string, input: { email: string; role: "owner" | "editor" }) =>
    mutate<{ invitation: EmployerMember; token?: string; replayed?: boolean }>(`${organizationPath(organizationId)}/invitations`, token, input),
  acceptInvitation: (token: string, invitationToken: string) =>
    mutate<{ organizationId: string; role: "owner" | "editor"; replayed?: boolean }>(`/employer/invitations/${encodeURIComponent(invitationToken)}/accept`, token, {}),
  removeMember: (token: string, organizationId: string, userId: string) =>
    mutate<void>(`${organizationPath(organizationId)}/members/${encodeURIComponent(userId)}`, token, undefined, "DELETE"),
  connectSource: (token: string, organizationId: string, url: string) =>
    mutate<{ source: EmployerSource; replayed?: boolean }>(`${organizationPath(organizationId)}/sources`, token, sourceConnectionPayload(url)),
  proposeMetadata: (token: string, organizationId: string, jobId: string, field: string, proposedValue: string) =>
    mutate<{ proposal: EmployerMetadataProposal; replayed?: boolean }>(`${organizationPath(organizationId)}/proposals`, token, metadataProposalPayload(jobId, field, proposedValue)),
  submitRole: (token: string, organizationId: string, input: Parameters<typeof directSubmissionPayload>[0]) =>
    mutate<{ submission: EmployerSubmission; replayed?: boolean }>(`${organizationPath(organizationId)}/submissions`, token, directSubmissionPayload(input)),
  closeSubmission: (token: string, organizationId: string, submissionId: string) =>
    mutate<{ submission: EmployerSubmission; replayed?: boolean }>(`${organizationPath(organizationId)}/submissions/${encodeURIComponent(submissionId)}/close`, token, {}),
};
