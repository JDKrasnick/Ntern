import type { EmptyBoardAcknowledgement } from './reviewed-source.js';
import { reviewedLeverExpansionSources } from './lever-expansion-data.js';
import { reviewedLeverOwnerApprovedExpansionSources } from './lever-owner-approved-expansion-data.js';

/**
 * Reviewed Lever employers.
 *
 * Lever's public Postings API has no company search and no authoritative
 * employer-identity field: a 200 response proves a site exists, not who owns
 * it. Ownership therefore cannot be established at runtime. It is established
 * once, by a person, from a page the employer controls, and recorded here as
 * evidence — which is what separates a reviewed source from a guessed one.
 *
 * Admission is defined in `docs/lever-company-onboarding-plan.md`. This file is
 * the machine-readable half of it, so a board cannot reach production without
 * the evidence that admitted it.
 */
export interface ReviewedLeverSource {
  id: string;
  /** Display name the catalog shows; never taken from the API response. */
  company: string;
  /** Lever site identifier, also enforced inside every application URL. */
  site: string;
  /**
   * Employer-controlled page that linked to this Lever site. This is the
   * ownership evidence: reviewing it is how a reviewer knows the site belongs to
   * the employer, and re-checking it is how they know it still does.
   */
  careersUrl: string;
  /** When a person reviewed `careersUrl` and admitted the board. */
  admittedAt: string;
  /**
   * `shadow` fetches, gates, and reports without publishing or notifying;
   * `published` enters the catalog. Promotion is this one field.
   */
  status: 'shadow' | 'published';
  /**
   * Lever serves the EU region from separate API and application hosts, so
   * region is part of source identity rather than something inferred at runtime.
   */
  region: 'global';
  /**
   * How ownership was established. `agent-verified` boards ship a matching
   * evidence record under `test/fixtures/lever/{site}/`, which
   * `npm run lever:manifest` enforces. `legacy-review` boards were admitted by a
   * person before that record existed; they remain subject to the re-verification
   * clock, and re-verifying one converts it.
   */
  evidenceStatus: 'agent-verified' | 'legacy-review';
  /** Set only after the owner confirms the board itself is empty. */
  emptyBoardAcknowledged?: EmptyBoardAcknowledgement;
}

export const reviewedLeverSources: ReviewedLeverSource[] = [
  {
    id: 'lever-palantir',
    company: 'Palantir Technologies',
    site: 'palantir',
    careersUrl: 'https://www.palantir.com/careers/',
    admittedAt: '2026-07-19',
    status: 'published',
    region: 'global',
    evidenceStatus: 'legacy-review',
  },
  {
    id: 'lever-plusai',
    company: 'PlusAI',
    site: 'plus-2',
    careersUrl: 'https://plus.ai/careers',
    admittedAt: '2026-07-19',
    status: 'published',
    region: 'global',
    evidenceStatus: 'legacy-review',
  },
  {
    id: 'lever-hermeus',
    company: 'Hermeus',
    site: 'hermeus',
    careersUrl: 'https://www.hermeus.com/careers',
    admittedAt: '2026-07-19',
    status: 'published',
    region: 'global',
    evidenceStatus: 'legacy-review',
  },
  {
    id: 'lever-xsolla',
    company: 'Xsolla',
    site: 'xsolla',
    careersUrl: 'https://xsolla.com/careers',
    admittedAt: '2026-07-19',
    status: 'published',
    region: 'global',
    evidenceStatus: 'legacy-review',
  },
  {
    id: 'lever-acds',
    company: 'Apprenticely',
    site: 'acds',
    careersUrl: 'https://apprenticely.org',
    admittedAt: '2026-07-30T00:00:00Z',
    status: 'shadow',
    region: 'global',
    evidenceStatus: 'agent-verified',
  },
  {
    id: 'lever-shyftlabs',
    company: 'ShyftLabs',
    site: 'shyftlabs',
    careersUrl: 'https://shyftlabs.io/',
    admittedAt: '2026-07-30T00:00:00Z',
    status: 'shadow',
    region: 'global',
    evidenceStatus: 'agent-verified',
  },
  ...reviewedLeverExpansionSources,
  ...reviewedLeverOwnerApprovedExpansionSources,
];

export function publishedLeverSources(sources = reviewedLeverSources): ReviewedLeverSource[] {
  return sources.filter((source) => source.status === 'published');
}
