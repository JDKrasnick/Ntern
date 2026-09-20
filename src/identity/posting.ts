import { createHash } from 'node:crypto';
import type { Internship, PostingAlias, PostingIdentity, PostingProvider, ProviderPostingEvidence } from '../types.js';

/** Referral parameters community feeds and campaigns append; none selects a posting. */
const TRACKING_PARAMETERS: Record<string, true> = {
  fbclid: true, gclid: true, gh_src: true, mc_cid: true, mc_eid: true, ref: true, source: true,
  utm_source: true, utm_medium: true, utm_campaign: true, utm_term: true, utm_content: true,
};

/** Employer-hosted ATS presentations observed and reviewed in the live catalog. */
const CUSTOM_ICIMS_TENANTS: Readonly<Record<string, string>> = {
  'careers.amd.com': 'amd',
  'campus-amd.icims.com': 'amd',
  'careers.jhuapl.edu': 'jhuapl',
  'careers.garmin.com': 'garmin',
  'careers.medpace.com': 'medpace',
  'jobs.keysight.com': 'keysight',
  'careers.clydeinc.com': 'clydeinc',
  'jobs.statefarm.com': 'statefarm',
  'careers.principal.com': 'principal',
  'careers.rivian.com': 'rivian',
  'jobs.constellationenergy.com': 'constellationenergy',
  'jobs.postholdings.com': 'postholdings',
  'jobs.stryten.com': 'stryten',
  'careers.gov2x.com': 'v2x',
  'careers.kindermorgan.com': 'kindermorgan',
  'careers.kpmg.ca': 'kpmg-ca',
  'careers.msasafety.com': 'msasafety',
  'jobs.zs.com': 'zs',
  'careers.mcdean.com': 'mcdean',
  'careers.na.panasonic.com': 'panasonic-na',
  'careers.publicisgroupe.com': 'publicisgroupe',
  'careers.spiritaero.com': 'spiritaero',
  'careers.ulta.com': 'ulta',
  'jobs.uhsinc.com': 'uhsinc',
  'careers.aarp.org': 'aarp',
  'careers.astrion.us': 'astrion',
  'careers.cdmsmith.com': 'cdmsmith',
  'careers.chick-fil-a.com': 'chick-fil-a',
  'careers.cobank.com': 'cobank',
  'careers.comed.com': 'comed',
  'careers.cvent.com': 'cvent',
  'careers.fastenterprises.com': 'fastenterprises',
  'careers.foundationfinance.com': 'foundationfinance',
  'careers.herzog.com': 'herzog',
  'careers.ice.com': 'ice',
  'careers.planview.com': 'planview',
  'careers.pnnl.gov': 'pnnl',
  'careers.sabresystems.com': 'sabresystems',
  'careers.trccompanies.com': 'trccompanies',
  'jobportal.reyesbeveragegroup.com': 'reyesbeveragegroup',
  'jobs.ajg.com': 'ajg',
  'jobs.bjc.org': 'bjc',
  'simventions.jibeapply.com': 'simventions',
  'spa.jibeapply.com': 'spa',
};

const CUSTOM_SUCCESSFACTORS_HOSTS = new Set([
  'jobs.l3harris.com',
  'careers.qorvo.com',
  'corningjobs.corning.com',
  'careers.gulfstream.com',
  'apply.edisoncareers.com',
  'careers.westinghousenuclear.com',
  'jobs.entergy.com',
  'careers.hfsinclair.com',
  'careers.dominionenergy.com',
  'careers.zurich.com',
  'careers.wecenergygroup.com',
  'jobs.cmc.com',
  'jobs.grainger.com',
  'careerprofile.epiroc.com',
  'careers.belden.com',
  'careers.huntingtoningalls.com',
  'jobs.nucor.com',
  'jobs.paccar.com',
  'jobs.ulalaunch.com',
  'mhicareers.com',
  'optimumcareers.com',
]);

function matchingGreenhouseId(url: URL, pathId?: string): string | undefined {
  const queryIds = url.searchParams.getAll('gh_jid');
  const queryId = queryIds[0];
  if (!queryId || queryIds.some((candidate) => candidate !== queryId)
      || !/^\d+$/.test(queryId) || (pathId && pathId !== queryId)) return undefined;
  return pathId ?? queryId;
}

/**
 * Parses a candidate posting ID from a custom Greenhouse presentation.
 * The caller must still prove the host belongs to exactly one reviewed source
 * and validate the ID against that source's active-posting checkpoint.
 */
export function customGreenhouseReference(url: URL, host: string): ProviderPostingReference | undefined {
  let match: RegExpExecArray | null;
  if (host === 'jumptrading.com' && /^\/hr\/job\/?$/i.test(url.pathname)) {
    const postingId = matchingGreenhouseId(url);
    return postingId ? { provider: 'greenhouse', tenant: 'jumptrading', postingId } : undefined;
  }
  if (host === 'coinbase.com' && (match = /^\/careers\/positions\/(\d+)\/?$/i.exec(url.pathname))) {
    const queryId = url.searchParams.get('gh_jid');
    if (queryId && queryId !== match[1]) return undefined;
    return { provider: 'greenhouse', tenant: 'coinbase', postingId: match[1]! };
  }
  if (host === 'careers.withwaymo.com' && /^\/jobs\/?$/i.test(url.pathname)) {
    const postingId = matchingGreenhouseId(url);
    return postingId ? { provider: 'greenhouse', tenant: 'waymo', postingId } : undefined;
  }
  if (host === 'flyzipline.com' && (match = /^\/open-roles(?:\/(\d+))?\/?$/i.exec(url.pathname))) {
    const postingId = matchingGreenhouseId(url, match[1]);
    return postingId ? { provider: 'greenhouse', tenant: 'flyzipline', postingId } : undefined;
  }
  if (host === 'zipline.com' && (match = /^\/open-roles(?:\/(\d+))?\/?$/i.exec(url.pathname))) {
    const postingId = matchingGreenhouseId(url, match[1]);
    return postingId ? { provider: 'greenhouse', tenant: 'flyzipline', postingId } : undefined;
  }
  const pathRoutes: Readonly<Record<string, { tenant: string; route: RegExp }>> = {
    'optiver.com': { tenant: 'optiver', route: /^\/join-us\/jobs\/(\d+)\/?$/i },
    'akunacapital.com': { tenant: 'akunacapital', route: /^\/careers\/job\/(\d+)\/?$/i },
    'careers.formlabs.com': { tenant: 'formlabs', route: /^\/job\/(\d+)\/apply\/?$/i },
    'epicgames.com': { tenant: 'epicgames', route: /^(?:\/site)?\/careers\/jobs\/(\d+)\/?$/i },
  };
  const route = pathRoutes[host];
  if (route && (match = route.route.exec(url.pathname))) {
    const queryId = url.searchParams.get('gh_jid');
    if (queryId && queryId !== match[1]) return undefined;
    return { provider: 'greenhouse', tenant: route.tenant, postingId: match[1]! };
  }
  if (host === 'tower-research.com' && /^\/open-positions\/?$/i.test(url.pathname)) {
    const postingId = matchingGreenhouseId(url);
    return postingId ? { provider: 'greenhouse', tenant: 'towerresearchcapital', postingId } : undefined;
  }
  const queryRoutes: Readonly<Record<string, { tenant: string; route: RegExp }>> = {
    'equipmentshare.com': { tenant: 'equipmentshare', route: /^\/careers\/openings\/?$/i },
    'hudsonrivertrading.com': { tenant: 'wehrtyou', route: /^\/careers\/job\/?$/i },
    'ast-science.com': { tenant: 'astspacemobile', route: /^\/company\/careers\/?$/i },
    'interstates.com': { tenant: 'interstates', route: /^\/careers\/jobs\/?$/i },
    'alayacare.com': { tenant: 'alayacare', route: /^\/open-positions\/?$/i },
    'asm.com': { tenant: 'asm', route: /^\/open-vacancies\/?$/i },
    'award.co': { tenant: 'awardco', route: /^\/position\/?$/i },
    'careers.toasttab.com': { tenant: 'toast', route: /^\/jobs\/?$/i },
    'gsacapital.com': { tenant: 'gsa-capital', route: /^\/careers\/gh\/?$/i },
    'isnetworld.com': { tenant: 'isn', route: /^\/[a-z]{2}\/about\/careers\/jobs\/?$/i },
    'ixl.com': { tenant: 'ixl-learning', route: /^\/company\/jobs\/?$/i },
    'nextiva.com': { tenant: 'nextiva', route: /^\/company\/careers-listing\/?$/i },
    'oldmissioncapital.com': { tenant: 'old-mission-capital', route: /^\/careers\/?$/i },
    'procogia.com': { tenant: 'procogia', route: /^\/about-us\/careers\/?$/i },
    'symphony.com': { tenant: 'symphony', route: /^\/company\/apply\/?$/i },
    'verition.com': { tenant: 'verition', route: /^\/open-positions\/?$/i },
    'workato.com': { tenant: 'workato', route: /^\/careers\/?$/i },
    'artisanpartners.com': { tenant: 'artisan-partners', route: /^\/careers\/career-opportunities\.html\/?$/i },
    'careers.upstart.com': { tenant: 'upstart', route: /^\/jobs\/?$/i },
    'clintonfoundation.org': { tenant: 'clinton-foundation', route: /^\/careers\/apply\/?$/i },
    'healthesystems.com': { tenant: 'healthesystems', route: /^\/unassigned\/careers-list\/?$/i },
    'iex.io': { tenant: 'iex', route: /^\/careers\/apply\/?$/i },
    'ignite-digital.com': { tenant: 'ignite-digital', route: /^\/careers\/job-listings\/?$/i },
    'kinexon.com': { tenant: 'kinexon', route: /^\/jobs\/?$/i },
    'nexaminds.ai': { tenant: 'nexaminds', route: /^\/careers\/?$/i },
    'pathai.com': { tenant: 'pathai', route: /^\/career\/job-post\/?$/i },
    'pindrop.com': { tenant: 'pindrop', route: /^\/careers\/job-title\/?$/i },
    'redventures.com': { tenant: 'red-ventures', route: /^\/careers\/positions\/open\/?$/i },
    'stepstonegroup.com': { tenant: 'stepstone-group', route: /^\/current-opportunities\/?$/i },
    'stokespace.com': { tenant: 'stoke-space', route: /^\/careers\/current-openings\/?$/i },
    'tripleringtech.com': { tenant: 'triple-ring-technologies', route: /^\/careers\/?$/i },
  };
  const queryRoute = queryRoutes[host];
  if (queryRoute?.route.test(url.pathname)) {
    const postingId = matchingGreenhouseId(url);
    return postingId ? { provider: 'greenhouse', tenant: queryRoute.tenant, postingId } : undefined;
  }
  if (host === 'quantbot.com' && (match = /^\/careers\/(\d+)\/?$/i.exec(url.pathname))) {
    const postingId = matchingGreenhouseId(url, match[1]);
    return postingId ? { provider: 'greenhouse', tenant: 'quantbottechnologies', postingId } : undefined;
  }
  if (host === 'd2l.com' && /^\/careers\/jobs\/?$/i.test(url.pathname)) {
    const postingId = matchingGreenhouseId(url);
    return postingId && url.searchParams.get('job_id') === postingId
      ? { provider: 'greenhouse', tenant: 'desire2learn', postingId } : undefined;
  }
  if (host === 'drw.com' && (match = /^\/work-at-drw\/listings\/[^/]*-(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'greenhouse', tenant: 'drweng', postingId: match[1]! };
  }
  const matchingPathRoutes: Readonly<Record<string, { tenant: string; route: RegExp }>> = {
    'x.company': { tenant: 'x', route: /^\/careers\/(\d+)\/?$/i },
    'careers.duolingo.com': { tenant: 'duolingo', route: /^\/jobs\/(\d+)\/?$/i },
    'rubrik.com': { tenant: 'rubrik', route: /^\/company\/careers\/departments\/job\.(\d+)\/?$/i },
    'samsara.com': { tenant: 'samsara', route: /^\/company\/careers\/roles\/(\d+)\/?$/i },
    'trlm.com': { tenant: 'trillium', route: /^\/apply\/(\d+)\/?$/i },
    'c3.ai': { tenant: 'c3', route: /^\/job-description\/(\d+)\/?$/i },
    'careers.datadoghq.com': { tenant: 'datadog', route: /^\/detail\/(\d+)\/?$/i },
    'opswat.com': { tenant: 'opswat', route: /^\/jobs\/(\d+)\/?$/i },
    'akqa.com': { tenant: 'akqa', route: /^\/jobs\/(\d+)\/?$/i },
    'alixpartners.com': { tenant: 'alixpartners', route: /^\/careers\/(\d+)\/?$/i },
    'dmgmedia.co.uk': { tenant: 'dmg-media', route: /^\/careers\/jobs\/id\/(\d+)\/?$/i },
    'esri.com': { tenant: 'esri', route: /^\/careers\/(\d+)\/?$/i },
    'helsing.ai': { tenant: 'helsing', route: /^\/jobs\/(\d+)\/?$/i },
    'payoneer.com': { tenant: 'payoneer', route: /^\/careers\/position\/(\d+)\/?$/i },
    'taboola.com': { tenant: 'taboola', route: /^\/careers\/job\/(\d+)\/?$/i },
  };
  const matchingPathRoute = matchingPathRoutes[host];
  if (matchingPathRoute && (match = matchingPathRoute.route.exec(url.pathname))) {
    const postingId = matchingGreenhouseId(url, match[1]);
    return postingId ? { provider: 'greenhouse', tenant: matchingPathRoute.tenant, postingId } : undefined;
  }
  if (host === 'pinterestcareers.com'
      && (match = /^\/jobs\/(\d+)(?:\/[^/]+)?\/?$/i.exec(url.pathname))) {
    const queryId = url.searchParams.get('gh_jid');
    if (queryId && queryId !== match[1]) return undefined;
    return { provider: 'greenhouse', tenant: 'pinterest', postingId: match[1]! };
  }
  if (host === 'american-equity.com' && /^\/about\/careers\/openings\/?$/i.test(url.pathname)) {
    const postingId = matchingGreenhouseId(url);
    return postingId ? { provider: 'greenhouse', tenant: 'americanequity', postingId } : undefined;
  }
  if (host === 'careers.aqr.com' && /^\/jobs\/?$/i.test(url.pathname)) {
    const postingId = matchingGreenhouseId(url);
    return postingId ? { provider: 'greenhouse', tenant: 'aqr', postingId } : undefined;
  }
  if (host === 'voloridge.com'
      && (match = /^\/jobs\/([a-z0-9-]+)\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'greenhouse', tenant: match[1]!.toLowerCase(), postingId: match[2]! };
  }
  if (host === 'peakenergy.com' && /^\/get-in-touch\/careers\/jobs\/?$/i.test(url.pathname)) {
    const postingId = matchingGreenhouseId(url);
    return postingId && url.searchParams.get('job_id') === postingId
      ? { provider: 'greenhouse', tenant: 'peak-energy', postingId } : undefined;
  }
  if (host === 'squarepoint-capital.com' && /^\/open-opportunities\/?$/i.test(url.pathname)) {
    const postingId = matchingGreenhouseId(url);
    return postingId && url.searchParams.get('id') === postingId
      ? { provider: 'greenhouse', tenant: 'squarepoint-capital', postingId } : undefined;
  }
  if (host === 'scale.com' && (match = /^\/careers\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'greenhouse', tenant: 'scaleai', postingId: match[1]! };
  }
  if (host === 'app.careerpuck.com'
      && (match = /^\/job-board\/([a-z0-9-]+)\/job\/(\d+)\/?$/i.exec(url.pathname))) {
    const queryId = url.searchParams.get('gh_jid');
    if (queryId && queryId !== match[2]) return undefined;
    return { provider: 'greenhouse', tenant: match[1]!.toLowerCase(), postingId: match[2]! };
  }
  return undefined;
}

/**
 * Case-insensitive referral/tracking parameter test. `utm_` is a whole family
 * rather than a fixed list, so it matches by prefix.
 */
export function isApplicationTrackingParameter(key: string): boolean {
  const lower = key.toLowerCase();
  return TRACKING_PARAMETERS[lower] === true || lower.startsWith('utm_');
}

function withoutTrailingSlash(pathname: string): string {
  return pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
}

/** Canonicalizes only syntax and reviewed provider presentation variants. */
export function canonicalizePostingUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Posting URL must use HTTP or HTTPS');
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (isApplicationTrackingParameter(key)) url.searchParams.delete(key);
  }

  const host = url.hostname.replace(/^www\./, '');
  let match: RegExpExecArray | null;
  if (host === 'jobs.ashbyhq.com' && (match = /^\/([^/]+)\/([^/]+)(?:\/application)?\/?$/i.exec(url.pathname))) {
    url.pathname = `/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
    url.searchParams.delete('embed');
  } else if ((host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host === 'job-boards.eu.greenhouse.io')
      && (match = /^\/([^/]+)\/jobs\/(\d+)\/?$/i.exec(url.pathname))) {
    url.hostname = 'job-boards.greenhouse.io';
    url.pathname = `/${match[1]!.toLowerCase()}/jobs/${match[2]}`;
    if (url.searchParams.get('gh_jid') === match[2]) url.searchParams.delete('gh_jid');
  } else if ((host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io')
      && /^\d+$/.test(url.searchParams.get('gh_jid') ?? '')
      && (match = /^\/([^/]+)\/?$/i.exec(url.pathname))) {
    // This is the one query-form Greenhouse presentation we accept: its host
    // and board path both scope the public ID. Custom-host gh_jid parameters
    // are parsed only by reviewedProviderUrlReference after host review.
    const postingId = url.searchParams.get('gh_jid')!;
    url.hostname = 'job-boards.greenhouse.io';
    url.pathname = `/${match[1]!.toLowerCase()}/jobs/${postingId}`;
    url.searchParams.delete('gh_jid');
  } else {
    url.pathname = withoutTrailingSlash(url.pathname);
  }
  url.searchParams.sort();
  return url.toString().replace(/\/$/, '');
}

export interface ProviderPostingReference {
  provider: PostingProvider;
  tenant?: string;
  postingId?: string;
}

/** Extracts immutable IDs only from reviewed routes. */
export function providerPostingReference(input: string): ProviderPostingReference {
  const url = new URL(canonicalizePostingUrl(input));
  const host = url.hostname.replace(/^www\./, '');
  let match: RegExpExecArray | null;
  if ((host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io' || host === 'job-boards.eu.greenhouse.io') && (match = /^\/([^/]+)\/jobs\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'greenhouse', tenant: match[1]!.toLowerCase(), postingId: match[2] };
  }
  if ((host === 'jobs.lever.co' || host === 'jobs.eu.lever.co')
      && (match = /^\/([^/]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/apply)?\/?$/i.exec(url.pathname))) {
    return { provider: 'lever', tenant: match[1]!.toLowerCase(), postingId: match[2]!.toLowerCase() };
  }
  if (host === 'jobs.ashbyhq.com' && (match = /^\/([^/]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/application)?\/?$/i.exec(url.pathname))) {
    return { provider: 'ashby', tenant: match[1]!.toLowerCase(), postingId: match[2]!.toLowerCase() };
  }
  if (host === 'shopify.com'
      && (match = /^\/careers\/[^/]*_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i.exec(url.pathname))) {
    const queryId = url.searchParams.get('ashby_jid');
    if (queryId && queryId.toLowerCase() !== match[1]!.toLowerCase()) return { provider: 'unknown' };
    return { provider: 'ashby', tenant: 'shopify', postingId: match[1]!.toLowerCase() };
  }
  if ((host === 'lifeattiktok.com' || host === 'joinbytedance.com') && (match = /^\/(?:search|position)\/(\d+)(?:\/detail)?\/?$/i.exec(url.pathname))) {
    return { provider: 'bytedance', tenant: 'bytedance', postingId: match[1] };
  }
  if (host === 'jobs.bytedance.com' && (match = /^\/[a-z-]+\/position\/(\d+)(?:\/detail)?\/?$/i.exec(url.pathname))) {
    return { provider: 'bytedance', tenant: 'bytedance', postingId: match[1] };
  }
  if (host === 'lifeattiktok.com'
      && (match = /^\/referral\/[^/]+\/campus\/position\/(\d+)\/detail\/?$/i.exec(url.pathname))) {
    return { provider: 'bytedance', tenant: 'bytedance', postingId: match[1] };
  }
  if (host.endsWith('.myworkdayjobs.com') && (match = /_([^/_]+)\/?$/i.exec(url.pathname))) {
    return { provider: 'workday', tenant: host.split('.')[0]!.toLowerCase(), postingId: match[1]!.toLowerCase() };
  }
  if (host.endsWith('.myworkdaysite.com')
      && (match = /^(?:\/[a-z]{2}-[a-z]{2})?\/recruiting\/([^/]+)\/([^/]+)\/job\/.+_([^/_]+)\/?$/i.exec(url.pathname))) {
    return {
      provider: 'workday',
      tenant: `${host}/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`,
      postingId: match[3]!.toLowerCase(),
    };
  }
  if (host.endsWith('.myworkdaysite.com')
      && (match = /^\/([^/]+)\/job\/.+_([^/_]+)\/?$/i.exec(url.pathname))) {
    return { provider: 'workday', tenant: `${host}/${match[1]!.toLowerCase()}`, postingId: match[2]!.toLowerCase() };
  }
  if (host === 'tesla.com'
      && (match = /^(?:\/[a-z]{2}(?:_[a-z]{2})?)?\/careers\/search\/job\/(?:[^/]*-)?(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'tesla', tenant: 'tesla', postingId: match[1] };
  }
  if (host === 'metacareers.com'
      && (match = /^\/(?:jobs|profile\/job_details)\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'meta', tenant: 'meta', postingId: match[1] };
  }
  if (host === 'janestreet.com'
      && (match = /^\/join-jane-street\/(?:position|apply)\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'janestreet', tenant: 'janestreet', postingId: match[1] };
  }
  if (host === 'higher.gs.com' && (match = /^\/roles\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'goldman-sachs', tenant: 'goldman-sachs', postingId: match[1] };
  }
  if (host === 'imc.com' && (match = /^\/[a-z]{2}\/careers\/jobs\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'imc', tenant: 'imc', postingId: match[1] };
  }
  if (host === 'jobs.smartrecruiters.com' && (match = /^\/([^/]+)\/(\d+)(?:-[^/]+)?\/?$/i.exec(url.pathname))) {
    return { provider: 'smartrecruiters', tenant: match[1]!.toLowerCase(), postingId: match[2]! };
  }
  const customIcimsTenant = CUSTOM_ICIMS_TENANTS[host];
  if (customIcimsTenant && (match = /^(?:\/careers-home)?\/jobs\/(\d+)(?:\/[^/]*)?\/?$/i.exec(url.pathname))) {
    return { provider: 'icims', tenant: customIcimsTenant, postingId: match[1] };
  }
  if (host.endsWith('.icims.com') && (match = /^\/jobs\/(\d+)(?:\/[^/]*)?\/(?:job|login)\/?$/i.exec(url.pathname))) {
    return { provider: 'icims', tenant: host.slice(0, -'.icims.com'.length), postingId: match[1] };
  }
  if (host.endsWith('.oraclecloud.com')
      && (match = /^\/hcmUI\/CandidateExperience\/[a-z]{2}\/sites\/([^/]+)\/job\/(\d+)\/?$/i.exec(url.pathname))) {
    // The candidate-experience site scopes the id: one pod can carry the same
    // posting id under two sites, so the scope is host plus site.
    return { provider: 'oracle', tenant: `${host}/${match[1]!.toLowerCase()}`, postingId: match[2]! };
  }
  // These routes are provider-owned and each carries both a stable tenant/host
  // scope and a provider-issued posting identifier.  Do not generalize them to
  // lookalike paths: a title slug, query parameter, or bare host is never an ID.
  if (host === 'jobs.successfactors.com'
      && (match = /^\/job\/([^/]+)\/[^/]+\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'successfactors', tenant: host, postingId: match[2]! };
  }
  if (CUSTOM_SUCCESSFACTORS_HOSTS.has(host)
      && (match = /^\/(?:[^/]+\/)?job\/(?:[^/]+\/)+(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'successfactors', tenant: host, postingId: match[1]! };
  }
  if (host.endsWith('.successfactors.com')
      && /^\/careers\/?$/i.test(url.pathname)
      && url.searchParams.get('career_ns')?.toLowerCase() === 'job_listing'
      && /^[a-z0-9-]+$/i.test(url.searchParams.get('company') ?? '')
      && /^\d+$/.test(url.searchParams.get('career_job_req_id') ?? '')) {
    return {
      provider: 'successfactors',
      tenant: url.searchParams.get('company')!.toLowerCase(),
      postingId: url.searchParams.get('career_job_req_id')!,
    };
  }
  if (host.endsWith('.sapsf.com')
      && /^\/career\/?$/i.test(url.pathname)
      && url.searchParams.get('career_ns')?.toLowerCase() === 'job_listing'
      && /^[a-z0-9-]+$/i.test(url.searchParams.get('company') ?? '')
      && /^\d+$/.test(url.searchParams.get('career_job_req_id') ?? '')) {
    return { provider: 'successfactors', tenant: url.searchParams.get('company')!.toLowerCase(), postingId: url.searchParams.get('career_job_req_id')! };
  }
  if (host === 'apply.workable.com'
      && (match = /^\/([a-z0-9-]+)\/j\/([a-f0-9]{10})(?:\/apply)?\/?$/i.exec(url.pathname))) {
    return { provider: 'workable', tenant: match[1]!.toLowerCase(), postingId: match[2]!.toLowerCase() };
  }
  if ((host === 'jobs.careers.microsoft.com' || host === 'careers.microsoft.com')
      && (match = /^\/(?:v2\/)?(?:global\/)?[a-z]{2}(?:-[a-z]{2})?\/job\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'microsoft', tenant: 'microsoft', postingId: match[1]! };
  }
  if (host === 'apply.careers.microsoft.com'
      && (match = /^\/careers\/job\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'microsoft', tenant: 'microsoft', postingId: match[1]! };
  }
  if (host === 'ats.rippling.com'
      && (match = /^\/(?:[a-z]{2}-[a-z]{2}\/)?([a-z0-9-]+)\/jobs\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i.exec(url.pathname))) {
    return { provider: 'rippling', tenant: match[1]!.toLowerCase(), postingId: match[2]!.toLowerCase() };
  }
  if (host.endsWith('.eightfold.ai')
      && (match = /^\/careers\/job\/([a-z0-9-]+)\/?$/i.exec(url.pathname))) {
    return { provider: 'eightfold', tenant: host, postingId: match[1]!.toLowerCase() };
  }
  if (host === 'recruiting.paylocity.com'
      && (match = /^\/recruiting\/jobs\/Details\/(\d+)(?:\/[a-z0-9-]+)?\/?$/i.exec(url.pathname))) {
    return { provider: 'paylocity', tenant: host, postingId: match[1]! };
  }
  if (host === 'jobs.jobvite.com'
      && (match = /^\/([a-z0-9-]+)\/job\/([a-z0-9]+)\/?$/i.exec(url.pathname))) {
    return { provider: 'jobvite', tenant: match[1]!.toLowerCase(), postingId: match[2]!.toLowerCase() };
  }
  if (host === 'amazon.jobs'
      && (match = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?jobs\/(\d+)(?:\/[^/]+)?\/?$/i.exec(url.pathname))) {
    return { provider: 'amazon', tenant: 'amazon', postingId: match[1]! };
  }
  if (host === 'google.com'
      && (match = /^\/about\/careers\/applications\/jobs\/results\/(\d+)(?:-[^/]*)?\/?$/i.exec(url.pathname))) {
    return { provider: 'google', tenant: 'google', postingId: match[1]! };
  }
  if (host.endsWith('.taleo.net')
      && (match = /^\/careersection\/([a-z0-9_-]+)\/jobdetail\.ftl\/?$/i.exec(url.pathname))
      && /^[a-z0-9_-]+$/i.test(url.searchParams.get('job') ?? '')) {
    return { provider: 'taleo', tenant: `${host}/${match[1]!.toLowerCase()}`, postingId: url.searchParams.get('job')!.toLowerCase() };
  }
  if (host === 'careers.united.com' && (match = /^\/us\/en\/job\/([a-z0-9_-]+)\/?$/i.exec(url.pathname))) {
    return { provider: 'united', tenant: 'united', postingId: match[1]!.toLowerCase() };
  }
  if (host === 'careers.sig.com' && (match = /^(?:\/[^/]+)?\/jobs\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'sig', tenant: 'sig', postingId: match[1]! };
  }
  if (host === 'careers.rivianvw.tech'
      && (match = /^\/([a-z0-9-]+)\/jobs\/(\d+)\/job\/?$/i.exec(url.pathname))) {
    return { provider: 'icims', tenant: match[1]!.toLowerCase(), postingId: match[2]! };
  }
  if (host === 'jobs.intuit.com'
      && (match = /^\/job\/[^/]+\/[^/]+\/\d+\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'intuit', tenant: 'intuit', postingId: match[1]! };
  }
  if (host === 'jobs.apple.com'
      && (match = /^\/[a-z]{2}-[a-z]{2}\/details\/(\d+)(?:-\d+)?(?:\/[^/]+)?\/?$/i.exec(url.pathname))) {
    return { provider: 'apple', tenant: 'apple', postingId: match[1]! };
  }
  if (host.endsWith('.bamboohr.com') && (match = /^\/careers\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'bamboohr', tenant: host.slice(0, -'.bamboohr.com'.length), postingId: match[1]! };
  }
  if (host === 'workforcenow.adp.com' && /^\/mascsr\/default\/mdf\/recruitment\/recruitment\.html$/i.test(url.pathname)
      && /^[a-f0-9-]{36}$/i.test(url.searchParams.get('cid') ?? '')
      && /^\d+$/.test(url.searchParams.get('jobId') ?? '')) {
    return { provider: 'adp', tenant: url.searchParams.get('cid')!.toLowerCase(), postingId: url.searchParams.get('jobId')! };
  }
  if (host === 'db.recsolu.com'
      && (match = /^\/external\/requisitions\/([a-z0-9_-]+)\/?$/i.exec(url.pathname))) {
    return { provider: 'recsolu', tenant: 'deutsche-bank', postingId: match[1]!.toLowerCase() };
  }
  if (host === 'deshaw.com' && (match = /^\/careers\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'deshaw', tenant: 'deshaw', postingId: match[1]! };
  }
  if (host === 'deshaw.com' && (match = /^\/careers\/[^/]*-(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'deshaw', tenant: 'deshaw', postingId: match[1]! };
  }
  if (host.endsWith('.yello.co') && (match = /^\/jobs\/([a-z0-9_-]+)\/?$/i.exec(url.pathname))) {
    return { provider: 'yello', tenant: host, postingId: match[1]!.toLowerCase() };
  }
  if (host.endsWith('.avature.net')
      && (match = /^\/[a-z]{2}_[a-z]{2}\/jobs\/jobdetail\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'avature', tenant: host, postingId: match[1]! };
  }
  if (host.endsWith('.avature.net')
      && (match = /^(?:\/[a-z]{2}_[a-z]{2})?\/careers\/jobdetail\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'avature', tenant: host, postingId: match[1]! };
  }
  if (host === 'apply.deloitte.com'
      && (match = /^\/[a-z]{2}_[a-z]{2}\/careers\/jobdetail\/[^/]+\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'avature', tenant: 'deloitte', postingId: match[1]! };
  }
  if (host === 'jobs.ea.com'
      && (match = /^\/[a-z]{2}_[a-z]{2}\/careers\/jobdetail\/[^/]+\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'avature', tenant: 'electronic-arts', postingId: match[1]! };
  }
  const employerRoutes: Readonly<Record<string, RegExp>> = {
    'career.mlp.com': /^\/careers\/job\/(\d+)\/?$/i,
    'careers.itw.com': /^\/global\/en\/job\/([a-z0-9-]+)\/?$/i,
    'careers.tranetechnologies.com': /^\/global\/en\/job\/([a-z0-9-]+)(?:\/[^/]+)?\/?$/i,
    'careers.snowflake.com': /^\/[a-z]{2}\/en\/job\/([a-z0-9]+)(?:\/[^/]+)?\/?$/i,
    'explore.jobs.netflix.net': /^\/careers\/job\/(\d+)\/?$/i,
    'careers.appian.com': /^\/jobs\/(\d+)(?:-[^/]+)?\/?$/i,
    'careers.fiserv.com': /^\/[a-z]{2}\/en\/job\/([a-z0-9]+)(?:\/[^/]+)?\/?$/i,
    'careers.cisco.com': /^\/global\/en\/job\/(\d+)\/?$/i,
    'careers.conehealth.com': /^\/[a-z]{2}\/en\/job\/([a-z0-9-]+)\/?$/i,
    'careers.qualcomm.com': /^\/careers\/job\/(\d+)\/?$/i,
    'capitalonecareers.com': /^\/job\/[^/]+\/[^/]+\/\d+\/(\d+)\/?$/i,
    'jobs.ascension.org': /^\/[a-z]{2}\/en\/job\/(\d+)\/?$/i,
    'flowtraders.com': /^\/careers\/job-description\/(\d+)\/?$/i,
  };
  const employerRoute = employerRoutes[host];
  if (employerRoute && (match = employerRoute.exec(url.pathname))) {
    return { provider: 'employer-career', tenant: host, postingId: match[1]!.toLowerCase() };
  }
  if (host === 'careers.point72.com' && /^\/CSJobDetail\/?$/i.test(url.pathname)
      && /^[a-z]+-\d+$/i.test(url.searchParams.get('jobCode') ?? '')) {
    return { provider: 'employer-career', tenant: 'point72', postingId: url.searchParams.get('jobCode')!.toLowerCase() };
  }
  if (host.endsWith('.pinpointhq.com')
      && (match = /^\/[a-z]{2}\/postings\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i.exec(url.pathname))) {
    return { provider: 'pinpoint', tenant: host.slice(0, -'.pinpointhq.com'.length), postingId: match[1]!.toLowerCase() };
  }
  if (host.endsWith('.applytojob.com')
      && (match = /^\/apply\/([a-z0-9]+)(?:\/[^/]+)?\/?$/i.exec(url.pathname))) {
    return { provider: 'applytojob', tenant: host.slice(0, -'.applytojob.com'.length), postingId: match[1]!.toLowerCase() };
  }
  if (host.endsWith('.breezy.hr')
      && (match = /^\/p\/([a-f0-9]{12})(?:-[^/]+)?\/?$/i.exec(url.pathname))) {
    return { provider: 'breezy', tenant: host.slice(0, -'.breezy.hr'.length), postingId: match[1]!.toLowerCase() };
  }
  if (host === 'jobs.gusto.com'
      && (match = /^\/postings\/[^/]*-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i.exec(url.pathname))) {
    return { provider: 'gusto', tenant: 'gusto', postingId: match[1]!.toLowerCase() };
  }
  if (host.endsWith('.hrmdirect.com') && /^\/employment\/job-opening\.php$/i.test(url.pathname)
      && /^\d+$/.test(url.searchParams.get('req') ?? '')) {
    return { provider: 'hrmdirect', tenant: host.slice(0, -'.hrmdirect.com'.length), postingId: url.searchParams.get('req')! };
  }
  if (host === 'sjobs.brassring.com' && /\/search\/home\/homewithpreload$/i.test(url.pathname)
      && /^\d+$/.test(url.searchParams.get('partnerid') ?? '')
      && /^\d+$/.test(url.searchParams.get('siteid') ?? '')
      && /^\d+$/.test(url.searchParams.get('jobid') ?? '')) {
    return { provider: 'brassring', tenant: `${url.searchParams.get('partnerid')}-${url.searchParams.get('siteid')}`, postingId: url.searchParams.get('jobid')! };
  }
  if (host.endsWith('.hiringthing.com')
      && (match = /^\/job\/(\d+)(?:\/[^/]+)?\/?$/i.exec(url.pathname))) {
    return { provider: 'hiringthing', tenant: host.slice(0, -'.hiringthing.com'.length), postingId: match[1]! };
  }
  return { provider: 'unknown' };
}

export function providerPostingAlias(reference: ProviderPostingReference): string | undefined {
  if (!reference.postingId || reference.provider === 'unknown') return undefined;
  return `provider:${reference.provider}:${reference.tenant ?? '-'}:${reference.postingId}`;
}

export function exactPostingKey(input: string): string {
  const canonicalUrl = canonicalizePostingUrl(input);
  return providerPostingAlias(providerPostingReference(canonicalUrl)) ?? `url:${canonicalUrl}`;
}

export function stableCanonicalJobId(exactKey: string): string {
  return createHash('sha256').update(`posting-v1:${exactKey}`).digest('hex').slice(0, 32);
}

export interface BuildPostingIdentityInput {
  applicationUrl: string;
  observedUrls?: string[];
  finalOfficialUrl?: string;
  /** Strongest evidence: immutable fields carried directly from a reviewed provider row. */
  providerEvidence?: ProviderPostingEvidence;
  /** Provider references already checked against a reviewed registry/checkpoint. */
  reviewedProviderReferences?: ProviderPostingReference[];
  employerId?: string;
  employerRequisitionId?: string;
  employerRequisitionAuthoritative?: boolean;
}

function alias(kind: PostingAlias['kind'], value: string, sourceUrl?: string): PostingAlias {
  return sourceUrl ? { kind, value, sourceUrl } : { kind, value };
}

export function buildPostingIdentity(input: BuildPostingIdentityInput): PostingIdentity {
  const urls = [
    input.applicationUrl,
    ...(input.providerEvidence?.urls ?? []),
    ...(input.observedUrls ?? []),
    ...(input.finalOfficialUrl ? [input.finalOfficialUrl] : []),
  ];
  const canonicalApplicationUrl = canonicalizePostingUrl(input.finalOfficialUrl ?? input.applicationUrl);
  const explicitReference = input.providerEvidence ? {
    provider: input.providerEvidence.provider,
    tenant: input.providerEvidence.tenant.toLowerCase(),
    postingId: input.providerEvidence.postingId.toLowerCase(),
  } satisfies ProviderPostingReference : undefined;
  // Provider routes in URLs are scoped provider-owned keys and are claimed like
  // any other exact reference; `resolvePostingAliases` and the registry both
  // quarantine reference sets that disagree on scope or name two ids.
  const exactRouteReferences = urls.map(providerPostingReference);
  const references = [explicitReference, ...(input.reviewedProviderReferences ?? []), ...exactRouteReferences]
    .filter((candidate): candidate is ProviderPostingReference => Boolean(candidate?.postingId));
  const reference = references[0] ?? { provider: 'unknown' as const };
  const aliases: PostingAlias[] = [];
  for (const url of urls) {
    const canonicalUrl = canonicalizePostingUrl(url);
    aliases.push(alias(url === input.finalOfficialUrl ? 'official-url' : 'application-url', `url:${canonicalUrl}`, url));
  }
  for (const candidate of references) {
    const providerAlias = providerPostingAlias(candidate);
    if (providerAlias) aliases.push(alias('provider-route', providerAlias));
  }
  const primaryProviderAlias = providerPostingAlias(reference);
  if (primaryProviderAlias) aliases.push(alias('provider-posting', primaryProviderAlias));
  if (input.employerRequisitionAuthoritative && input.employerRequisitionId && input.employerId) {
    aliases.push(alias('employer-requisition', `requisition:${input.employerId}:${input.employerRequisitionId.trim().toLowerCase()}`));
  }
  const uniqueAliases = [...new Map(aliases.map((item) => [`${item.kind}:${item.value}`, item])).values()]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value));
  const exactKey = primaryProviderAlias
    ?? uniqueAliases.find((item) => item.kind === 'employer-requisition')?.value
    ?? `url:${canonicalApplicationUrl}`;
  return {
    provider: reference.provider,
    ...(reference.tenant ? { tenant: reference.tenant } : {}),
    ...(reference.postingId ? { providerPostingId: reference.postingId } : {}),
    ...(input.employerRequisitionId ? { employerRequisitionId: input.employerRequisitionId } : {}),
    ...(input.employerRequisitionAuthoritative !== undefined ? { employerRequisitionAuthoritative: input.employerRequisitionAuthoritative } : {}),
    canonicalApplicationUrl,
    aliases: uniqueAliases,
    canonicalJobId: stableCanonicalJobId(exactKey),
  };
}

export type AliasResolution =
  | { outcome: 'create'; canonicalJobId: string; aliases: string[] }
  | { outcome: 'merge'; canonicalJobId: string; aliases: string[] }
  | {
      outcome: 'quarantine';
      aliases: string[];
      conflictingCanonicalJobIds: string[];
      reason:
        | 'aliases-resolve-to-different-jobs'
        | 'multiple-immutable-provider-postings'
        | 'provider-scope-mismatch'
        | 'employer-scope-mismatch'
        | 'multiple-authoritative-requisitions';
    };

/** Pure decision used before an atomic alias-registry transaction. */
export function resolvePostingAliases(identity: PostingIdentity, claims: ReadonlyMap<string, string>): AliasResolution {
  const aliases = [...new Set(identity.aliases.map((item) => item.value))].sort();
  const providerPostingGroups = new Map<string, Set<string>>();
  for (const value of aliases.filter((item) => item.startsWith('provider:'))) {
    const [, provider, tenant, postingId] = value.split(':');
    if (!provider || !tenant || !postingId) continue;
    const group = `${provider}:${tenant}`;
    const ids = providerPostingGroups.get(group) ?? new Set<string>();
    ids.add(postingId);
    providerPostingGroups.set(group, ids);
  }
  if (providerPostingGroups.size > 1) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [], reason: 'provider-scope-mismatch' };
  }
  if ([...providerPostingGroups.values()].some((ids) => ids.size > 1)) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [], reason: 'multiple-immutable-provider-postings' };
  }
  const requisitions = aliases.filter((value) => value.startsWith('requisition:'))
    .map((value) => value.split(':')).filter((parts) => parts[1] && parts[2]);
  const requisitionEmployers = new Set(requisitions.map((parts) => parts[1]!));
  if (requisitionEmployers.size > 1) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [], reason: 'employer-scope-mismatch' };
  }
  if (new Set(requisitions.map((parts) => `${parts[1]}:${parts[2]}`)).size > 1) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [], reason: 'multiple-authoritative-requisitions' };
  }
  const claimedIds = [...new Set(aliases.map((item) => claims.get(item)).filter((item): item is string => Boolean(item)))].sort();
  if (claimedIds.length > 1) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: claimedIds, reason: 'aliases-resolve-to-different-jobs' };
  }
  if (claimedIds.length === 1) return { outcome: 'merge', canonicalJobId: claimedIds[0]!, aliases };
  return { outcome: 'create', canonicalJobId: identity.canonicalJobId, aliases };
}

/** Prevents a caller-provided lookup hint from bridging two reviewed exact IDs. */
export function preferredJobIdentityConflicts(identity: PostingIdentity, job: Internship | undefined): boolean {
  if (!job) return false;
  const incoming = new Set(identity.aliases.map((alias) => alias.value));
  const confirmed = new Set(job.sourceReferences.flatMap((reference) =>
    reference.postingIdentityDecision?.status === 'confirmed' ? [reference.postingIdentityDecision.exactKey] : []));
  if (job.postingIdentityStatus === 'confirmed') {
    for (const alias of job.postingIdentity?.aliases ?? []) {
      if (alias.value.startsWith('provider:') || alias.value.startsWith('requisition:')) confirmed.add(alias.value);
    }
    // A confirmed URL-only identity can only have been created by the reviewed
    // canonical-URL contract. Provider-backed jobs also compare their claimed
    // provider reference, which now includes scoped provider routes.
    if (!confirmed.size && job.postingIdentity?.provider === 'unknown') {
      for (const alias of job.postingIdentity.aliases) confirmed.add(alias.value);
    }
  }
  return confirmed.size > 0 && ![...confirmed].some((exactKey) => incoming.has(exactKey));
}
