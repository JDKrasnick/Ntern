/**
 * One score used to answer three different questions at once, so a page we
 * could not read looked the same as a link that was wrong. They are separated
 * here:
 *
 * 1. attribution — is this posting really this employer's?
 * 2. reachability — does the destination load?
 * 3. description — does the page describe this role?
 *
 * Attribution is the strongest evidence and needs no request. A posting the
 * provider's own API served, whose URL matches the contract for a reviewed
 * board, is attributed by construction; fetching the page afterwards can only
 * subtract from what is already proven. Description is enrichment, never a gate:
 * a page rendered by JavaScript tells us nothing about whether the link works.
 */

/** How the posting was tied to the employer, strongest first. */
export type AttributionBasis = 'provider-api' | 'reviewed-board' | 'unattributed';

/**
 * `implied` means attribution already guarantees the destination — the provider
 * served this posting minutes ago. `blocked` means the server answered but
 * refused to be read, which says nothing about the posting. `gone` is the only
 * outcome that proves the destination is bad.
 */
export type Reachability = 'implied' | 'live' | 'blocked' | 'gone' | 'unreachable';

export interface ApplicationVerification {
  attribution: AttributionBasis;
  reachability: Reachability;
  /**
   * Whether the page's own content agreed with the listing, or `undefined` when
   * the page was never inspected. Enrichment only.
   */
  described?: boolean;
  alertEligible: boolean;
  /** A destination proven bad, which is the only reason to hide a role. */
  quarantine: boolean;
}

export interface BoardReference {
  provider: 'greenhouse' | 'lever';
  /** Board token or Lever site, as it appears in the application URL. */
  token: string;
  postingId: string;
}

/**
 * Extracts the board and posting an application URL points at, so it can be
 * checked against a board this catalog already polls.
 */
export function boardReference(applyUrl: string): BoardReference | undefined {
  let url: URL;
  try { url = new URL(applyUrl); } catch { return undefined; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io') {
    const match = /^\/([^/]+)\/jobs\/(\d+)\/?$/.exec(url.pathname);
    return match ? { provider: 'greenhouse', token: match[1]!.toLowerCase(), postingId: match[2]! } : undefined;
  }
  if (host === 'jobs.lever.co') {
    const match = /^\/([^/]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/apply)?\/?$/i.exec(url.pathname);
    return match ? { provider: 'lever', token: match[1]!.toLowerCase(), postingId: match[2]! } : undefined;
  }
  return undefined;
}

/** Classifies a validation failure by what it proves about the destination. */
export function reachabilityFromFailure(error: unknown): Reachability {
  const message = error instanceof Error ? error.message : String(error);
  const status = Number(/HTTP (\d{3})/.exec(message)?.[1]);
  if (status === 404 || status === 410) return 'gone';
  if (status === 401 || status === 403 || status === 406 || status === 429) return 'blocked';
  return 'unreachable';
}

/** Classifies a successful read by whether the page could actually be inspected. */
export function reachabilityFromSignals(signals: readonly string[]): Reachability {
  if (signals.includes('access restricted to scraper')) return 'blocked';
  if (signals.includes('temporary server failure')) return 'unreachable';
  return 'live';
}

/**
 * A role alerts when something vouches for it and nothing disproves it.
 * Attribution vouches on its own. Without attribution the page has to, which is
 * the pre-existing behaviour for employer-hosted destinations we cannot
 * cross-check.
 */
export function verifyApplication(input: {
  attribution: AttributionBasis;
  reachability: Reachability;
  /** Omit when the page was not inspected: absent evidence is not evidence against. */
  described?: boolean;
}): ApplicationVerification {
  const { attribution, reachability, described } = input;
  const attributed = attribution !== 'unattributed';
  return {
    attribution,
    reachability,
    ...(described === undefined ? {} : { described }),
    alertEligible: reachability !== 'gone' && (attributed || described !== false),
    quarantine: reachability === 'gone',
  };
}
