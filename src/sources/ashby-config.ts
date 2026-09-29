import type { ReviewedSourceRecord } from './reviewed-source.js';
import { ashbyPromotionEvidence } from './ashby-promotion-evidence.js';
import { reviewedAshbyExpansionSources } from './ashby-expansion-data.js';
import { reviewedAshbyOwnerApprovedExpansionSources } from './ashby-owner-approved-expansion-data.js';

export type ReviewedAshbySource = ReviewedSourceRecord & {
  identity: ReviewedSourceRecord['identity'] & { provider: 'ashby'; apiRegion: 'global' };
};

/** Human-reviewed Ashby boards consumed by the independent shadow/published runtime. */
const admittedAshbySources: ReviewedAshbySource[] = [
  {
    id: 'ashby-etched', company: 'Etched', identity: { provider: 'ashby', boardKey: 'etched', apiRegion: 'global' },
    careersUrl: 'https://www.etched.com/join', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-deepgram', company: 'Deepgram', identity: { provider: 'ashby', boardKey: 'Deepgram', apiRegion: 'global' },
    careersUrl: 'https://deepgram.com/careers', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-cohere', company: 'Cohere', identity: { provider: 'ashby', boardKey: 'cohere', apiRegion: 'global' },
    careersUrl: 'https://cohere.com/careers', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-mistral-ai', company: 'Mistral AI', identity: { provider: 'ashby', boardKey: 'mistral.ai', apiRegion: 'global' },
    careersUrl: 'https://mistral.ai/careers/', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-partly', company: 'Partly', identity: { provider: 'ashby', boardKey: 'partly.com', apiRegion: 'global' },
    careersUrl: 'https://www.partly.com/careers', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-notion', company: 'Notion', identity: { provider: 'ashby', boardKey: 'notion', apiRegion: 'global' },
    careersUrl: 'https://www.notion.com/careers', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-sentry', company: 'Sentry', identity: { provider: 'ashby', boardKey: 'sentry', apiRegion: 'global' },
    careersUrl: 'https://sentry.io/careers/', admittedAt: '2026-08-18T01:16:13.703Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-alan', company: 'Alan', identity: { provider: 'ashby', boardKey: 'alan', apiRegion: 'global' },
    careersUrl: 'https://alan.com/en/careers', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-base-power', company: 'Base Power', identity: { provider: 'ashby', boardKey: 'base-power', apiRegion: 'global' },
    careersUrl: 'https://www.basepowercompany.com/open-roles', admittedAt: '2026-08-14T04:04:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-reonic', company: 'Reonic', identity: { provider: 'ashby', boardKey: 'reonic', apiRegion: 'global' },
    careersUrl: 'https://reonic.com/en-ca/about/jobs/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-terranova', company: 'Terranova', identity: { provider: 'ashby', boardKey: 'Terranova', apiRegion: 'global' },
    careersUrl: 'https://www.terranova.inc/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-melius', company: 'Melius', identity: { provider: 'ashby', boardKey: 'melius', apiRegion: 'global' },
    careersUrl: 'https://www.melius.com/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-rho', company: 'Rho', identity: { provider: 'ashby', boardKey: 'rho', apiRegion: 'global' },
    careersUrl: 'https://www.rho.co/careers', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-ctgt', company: 'CTGT', identity: { provider: 'ashby', boardKey: 'ctgt', apiRegion: 'global' },
    careersUrl: 'https://www.ctgt.ai/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-opusclip', company: 'OpusClip', identity: { provider: 'ashby', boardKey: 'opusclip', apiRegion: 'global' },
    careersUrl: 'https://www.opus.pro/careers', admittedAt: '2026-08-14T04:04:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-windborne-systems', company: 'WindBorne Systems', identity: { provider: 'ashby', boardKey: 'windborne-systems', apiRegion: 'global' },
    careersUrl: 'https://windbornesystems.com/careers/firmware-intern', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-persona-ai', company: 'Persona AI', identity: { provider: 'ashby', boardKey: 'persona.ai', apiRegion: 'global' },
    careersUrl: 'https://persona.ai/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-skydio', company: 'Skydio', identity: { provider: 'ashby', boardKey: 'skydio', apiRegion: 'global' },
    careersUrl: 'https://www.skydio.com/jobs/cc83824e-a1cd-4bc7-9206-7264da9fbd61/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-heliux', company: 'Heliux', identity: { provider: 'ashby', boardKey: 'heliux', apiRegion: 'global' },
    careersUrl: 'https://www.heliux.com/careers', admittedAt: '2026-08-14T04:04:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-beaconsoftware', company: 'Beacon Software', identity: { provider: 'ashby', boardKey: 'beaconsoftware', apiRegion: 'global' },
    careersUrl: 'https://www.beaconsoftware.com/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-centerfield', company: 'Centerfield', identity: { provider: 'ashby', boardKey: 'centerfield', apiRegion: 'global' },
    careersUrl: 'https://www.centerfield.com/careers', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-rivianvw-tech', company: 'RV Tech', identity: { provider: 'ashby', boardKey: 'rivianvw.tech', apiRegion: 'global' },
    careersUrl: 'https://rivianvw.tech/', admittedAt: '2026-08-09T15:55:23Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-circleback', company: 'Circleback', identity: { provider: 'ashby', boardKey: 'circleback', apiRegion: 'global' },
    careersUrl: 'https://circleback.ai/jobs', admittedAt: '2026-08-14T04:04:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-eragon', company: 'Eragon', identity: { provider: 'ashby', boardKey: 'Eragon', apiRegion: 'global' },
    careersUrl: 'https://www.eragon.ai/careers/applied-ai-intern', admittedAt: '2026-08-09T23:02:24.286Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-modal', company: 'Modal', identity: { provider: 'ashby', boardKey: 'modal', apiRegion: 'global' },
    careersUrl: 'https://modal.com/company', admittedAt: '2026-08-09T23:02:24.286Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-yotta', company: 'Yotta Labs', identity: { provider: 'ashby', boardKey: 'yotta', apiRegion: 'global' },
    careersUrl: 'https://yottalabs.ai/', admittedAt: '2026-08-14T04:04:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-anthelioncap', company: 'Anthelion Capital', identity: { provider: 'ashby', boardKey: 'anthelioncap', apiRegion: 'global' },
    careersUrl: 'https://www.anthelioncap.com/careers', admittedAt: '2026-08-09T23:02:24.286Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-saronic', company: 'Saronic', identity: { provider: 'ashby', boardKey: 'saronic', apiRegion: 'global' },
    careersUrl: 'https://www.saronic.com/', admittedAt: '2026-08-09T23:02:24.286Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-firstordereffects', company: 'First Order Effects', identity: { provider: 'ashby', boardKey: 'firstordereffects', apiRegion: 'global' },
    careersUrl: 'https://firstordereffects.com/careers.html', admittedAt: '2026-08-09T23:02:24.286Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-junior', company: 'Junior', identity: { provider: 'ashby', boardKey: 'junior', apiRegion: 'global' },
    careersUrl: 'https://junior.ai/careers', admittedAt: '2026-08-09T23:02:24.286Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-airwallex', company: 'Airwallex', identity: { provider: 'ashby', boardKey: 'airwallex', apiRegion: 'global' },
    careersUrl: 'https://www.airwallex.com/careers.html', admittedAt: '2026-08-09T23:02:24.286Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-netic', company: 'Netic', identity: { provider: 'ashby', boardKey: 'netic', apiRegion: 'global' },
    careersUrl: 'https://www.netic.ai/company', admittedAt: '2026-08-09T23:02:24.286Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-retell-ai', company: 'Retell AI', identity: { provider: 'ashby', boardKey: 'retell-ai', apiRegion: 'global' },
    careersUrl: 'https://www.retellai.com/careers', admittedAt: '2026-08-09T23:02:24.286Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-quadrillion-labs', company: 'Quadrillion', identity: { provider: 'ashby', boardKey: 'quadrillion-labs', apiRegion: 'global' },
    careersUrl: 'https://careers.quadrillion.io/', admittedAt: '2026-08-14T04:04:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-pylon-labs', company: 'Pylon', identity: { provider: 'ashby', boardKey: 'pylon-labs', apiRegion: 'global' },
    careersUrl: 'https://usepylon.com/careers', admittedAt: '2026-08-14T04:04:00Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-nationgraph', company: 'NationGraph', identity: { provider: 'ashby', boardKey: 'NationGraph', apiRegion: 'global' },
    careersUrl: 'https://www.nationgraph.com/about-us', admittedAt: '2026-08-09T23:02:24.286Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-matx', company: 'MatX', identity: { provider: 'ashby', boardKey: 'matx', apiRegion: 'global' },
    careersUrl: 'https://www.matx.com/jobs', admittedAt: '2026-09-29T23:43:43.478Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  {
    id: 'ashby-amplitude', company: 'Amplitude', identity: { provider: 'ashby', boardKey: 'amplitude', apiRegion: 'global' },
    careersUrl: 'https://amplitude.com/careers', admittedAt: '2026-09-29T23:43:44.177Z', evidenceState: 'ownership-verified',
    allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
  },
  ...reviewedAshbyExpansionSources as ReviewedAshbySource[],
  ...reviewedAshbyOwnerApprovedExpansionSources as ReviewedAshbySource[],
];

/**
 * Promotion evidence upgrades a reviewed source to published. Newly admitted
 * sources remain shadow-only until their observation window is complete.
 */
export const reviewedAshbySources: ReviewedAshbySource[] = admittedAshbySources.map((source) => {
  const promotionEvidence = ashbyPromotionEvidence[source.id];
  return promotionEvidence ? { ...source, status: 'published', promotionEvidence } : source;
});

/** Ordered expansion replacements not yet reviewed or admitted. */
export const ashbyExpansionFallbacks = [] as const;
