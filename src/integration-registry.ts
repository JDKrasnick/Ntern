import type { LeverAdmission } from './store.js';
import type { SourceHealth } from './types.js';
import { defaultSources } from './sources/index.js';
import { reviewedAshbySources } from './sources/ashby-config.js';
import { reviewedGreenhouseSources } from './sources/greenhouse-config.js';
import { reviewedLeverSources } from './sources/lever-config.js';

export type IntegrationCategory = 'catalog-source' | 'application-detection' | 'notification-delivery';
export type SourceAction = 'pause' | 'resume' | 'replay' | 'quarantine' | 'recover' | 'acknowledge' | 'resolve' | 'set-tier';
export type ProviderWorkflow = 'candidate-review';

export interface NormalizedOperationsSource {
  sourceId: string;
  provider: string;
  region: string;
  displayName: string;
  careersUrl?: string;
  mode: 'published' | 'shadow';
  boardToken: string;
  evidenceStatus?: string;
  checkpointId: string;
}

export interface OperationsSourceContext {
  leverAdmissions?: LeverAdmission[];
}

export interface CatalogSourceProviderDefinition {
  id: string;
  displayName: string;
  category: Extract<IntegrationCategory, 'catalog-source'>;
  regions: readonly string[];
  defaultRegion: string;
  /**
   * How long a source may go without a successful snapshot before the
   * operations surface reports it `degraded`. Every fleet sets three sweep
   * cadences — 90 minutes for the half-hourly crons (greenhouse, lever, ashby)
   * and 30 minutes for GitHub's ten-minute cron — so the window tolerates two
   * missed sweeps. Measured 2026-09-16 after the dispatch-lease fix: GitHub
   * success intervals sit at the ten-minute cadence, so the window holds ~3x
   * headroom; a source that trips it has genuinely missed its sweeps.
   */
  freshnessWindowMs: number;
  sourceAuthority: 'official-provider' | 'reviewed-community';
  queues: {
    work: string;
    deadLetter: string;
  };
  alarmPrefix: string;
  runtime: {
    awsParameterSegment: string;
    cloudflareWorkBinding: `${Uppercase<string>}_QUEUE`;
    cloudflareDeadLetterBinding: `${Uppercase<string>}_DLQ`;
    cloudflareQueueIdBinding: `${Uppercase<string>}_QUEUE_ID`;
    awsSchedule: string;
    cloudflareCron: string;
    awsMainStackAlarm?: { evaluationPeriods: number; freshnessDescription: string };
  };
  sourceActions: readonly SourceAction[];
  workflows: readonly ProviderWorkflow[];
  matchesSourceId(sourceId: string): boolean;
  operationsSources(context: OperationsSourceContext): NormalizedOperationsSource[];
  replayMessage(sourceId: string, scheduledAt: string, runId: string): Record<string, unknown>;
}

const commonSourceActions = [
  'pause', 'resume', 'replay', 'quarantine', 'recover', 'acknowledge', 'resolve', 'set-tier',
] as const satisfies readonly SourceAction[];

const checkpointId = (sourceId: string, mode: 'published' | 'shadow') => mode === 'shadow' ? `shadow-${sourceId}` : sourceId;
const atsReplayMessage = (provider: string, sourceId: string, scheduledAt: string, runId: string) => ({
  version: 1,
  sourceId,
  scheduledAt,
  force: true,
  ...(provider === 'greenhouse' ? {} : { runId }),
});

/**
 * Provider-level integration configuration. This is deliberately separate
 * from reviewed board configuration and from authorized application partners.
 * Queue names are portable symbols; runtimes resolve them to SQS URLs or
 * Cloudflare Queue bindings at their boundary.
 */
export const integrationRegistry = {
  greenhouse: {
    id: 'greenhouse',
    displayName: 'Greenhouse',
    category: 'catalog-source',
    regions: ['unknown'],
    defaultRegion: 'unknown',
    freshnessWindowMs: 90 * 60_000,
    sourceAuthority: 'official-provider',
    queues: { work: 'catalog.greenhouse.work', deadLetter: 'catalog.greenhouse.dead-letter' },
    alarmPrefix: 'InternNotifsGreenhouse-',
    runtime: {
      awsParameterSegment: 'greenhouse', cloudflareWorkBinding: 'GREENHOUSE_QUEUE', cloudflareDeadLetterBinding: 'GREENHOUSE_DLQ', cloudflareQueueIdBinding: 'GREENHOUSE_QUEUE_ID',
      awsSchedule: 'cron(12,42 * * * ? *)', cloudflareCron: '12,42 * * * *',
    },
    sourceActions: commonSourceActions,
    workflows: [],
    matchesSourceId: (sourceId: string) => /^(?:shadow-)?greenhouse-/u.test(sourceId),
    operationsSources: () => reviewedGreenhouseSources.map((source) => ({
      sourceId: source.id,
      provider: 'greenhouse',
      region: 'unknown',
      displayName: source.displayName,
      careersUrl: source.careersUrl,
      mode: source.status,
      boardToken: source.boardToken,
      evidenceStatus: source.evidenceStatus,
      checkpointId: checkpointId(source.id, source.status),
    })),
    replayMessage: (sourceId: string, scheduledAt: string, runId: string) => atsReplayMessage('greenhouse', sourceId, scheduledAt, runId),
  },
  lever: {
    id: 'lever',
    displayName: 'Lever',
    category: 'catalog-source',
    regions: ['global'],
    defaultRegion: 'global',
    freshnessWindowMs: 90 * 60_000,
    sourceAuthority: 'official-provider',
    queues: { work: 'catalog.lever.work', deadLetter: 'catalog.lever.dead-letter' },
    alarmPrefix: 'InternNotifsLever-',
    runtime: {
      awsParameterSegment: 'lever', cloudflareWorkBinding: 'LEVER_QUEUE', cloudflareDeadLetterBinding: 'LEVER_DLQ', cloudflareQueueIdBinding: 'LEVER_QUEUE_ID',
      awsSchedule: 'cron(22,52 * * * ? *)', cloudflareCron: '22,52 * * * *',
      awsMainStackAlarm: { evaluationPeriods: 1, freshnessDescription: 'A lever source has gone 90 minutes without a trusted snapshot.' },
    },
    sourceActions: commonSourceActions,
    workflows: ['candidate-review'],
    matchesSourceId: (sourceId: string) => /^(?:shadow-)?lever-/u.test(sourceId),
    operationsSources: (context: OperationsSourceContext) => {
      const sources = new Map(reviewedLeverSources.map((source) => [source.id, source]));
      for (const admission of context.leverAdmissions ?? []) sources.set(admission.source.id, admission.source);
      return [...sources.values()].map((source) => ({
        sourceId: source.id,
        provider: 'lever',
        region: source.region,
        displayName: source.company,
        careersUrl: source.careersUrl,
        mode: source.status,
        boardToken: source.site,
        evidenceStatus: source.evidenceStatus,
        checkpointId: checkpointId(source.id, source.status),
      }));
    },
    replayMessage: (sourceId: string, scheduledAt: string, runId: string) => atsReplayMessage('lever', sourceId, scheduledAt, runId),
  },
  ashby: {
    id: 'ashby',
    displayName: 'Ashby',
    category: 'catalog-source',
    regions: ['global'],
    defaultRegion: 'global',
    freshnessWindowMs: 90 * 60_000,
    sourceAuthority: 'official-provider',
    queues: { work: 'catalog.ashby.work', deadLetter: 'catalog.ashby.dead-letter' },
    alarmPrefix: 'InternNotifsAshby-',
    runtime: {
      awsParameterSegment: 'ashby', cloudflareWorkBinding: 'ASHBY_QUEUE', cloudflareDeadLetterBinding: 'ASHBY_DLQ', cloudflareQueueIdBinding: 'ASHBY_QUEUE_ID',
      awsSchedule: 'cron(2,32 * * * ? *)', cloudflareCron: '2,32 * * * *',
    },
    sourceActions: commonSourceActions,
    workflows: [],
    matchesSourceId: (sourceId: string) => /^(?:shadow-)?ashby-/u.test(sourceId),
    operationsSources: () => reviewedAshbySources.map((source) => ({
      sourceId: source.id,
      provider: 'ashby',
      region: source.identity.apiRegion,
      displayName: source.company,
      careersUrl: source.careersUrl,
      mode: source.status,
      boardToken: source.identity.boardKey,
      evidenceStatus: source.evidenceState,
      checkpointId: checkpointId(source.id, source.status),
    })),
    replayMessage: (sourceId: string, scheduledAt: string, runId: string) => atsReplayMessage('ashby', sourceId, scheduledAt, runId),
  },
  github: {
    id: 'github',
    displayName: 'GitHub community sources',
    category: 'catalog-source',
    regions: ['unknown'],
    defaultRegion: 'unknown',
    freshnessWindowMs: 30 * 60_000,
    sourceAuthority: 'reviewed-community',
    queues: { work: 'catalog.github.work', deadLetter: 'catalog.github.dead-letter' },
    alarmPrefix: 'InternNotifs-',
    runtime: {
      awsParameterSegment: 'github', cloudflareWorkBinding: 'GITHUB_QUEUE', cloudflareDeadLetterBinding: 'GITHUB_DLQ', cloudflareQueueIdBinding: 'GITHUB_QUEUE_ID',
      awsSchedule: 'cron(7/10 * * * ? *)', cloudflareCron: '7-57/10 * * * *',
      awsMainStackAlarm: { evaluationPeriods: 6, freshnessDescription: 'A github source has gone 30 minutes without a trusted snapshot.' },
    },
    sourceActions: commonSourceActions,
    workflows: [],
    // The general Markdown fleet historically owns every non-ATS source ID;
    // exact checked-in IDs are exposed in operations, while test and future
    // community connectors retain the same health classification.
    matchesSourceId: (sourceId: string) => Boolean(sourceId)
      && !/^(?:shadow-)?(?:greenhouse|lever|ashby)-/u.test(sourceId),
    operationsSources: () => defaultSources.map((source) => ({
      sourceId: source.id,
      provider: 'github',
      region: 'unknown',
      displayName: source.id,
      mode: 'published',
      boardToken: source.id,
      evidenceStatus: 'reviewed-community',
      checkpointId: source.id,
    })),
    replayMessage: (sourceId: string) => ({ sourceId, force: true }),
  },
} as const satisfies Record<string, CatalogSourceProviderDefinition>;

export type CatalogProviderId = keyof typeof integrationRegistry;
type RegisteredCatalogProvider = (typeof integrationRegistry)[CatalogProviderId];
export type RegisteredOperationsSource = Omit<NormalizedOperationsSource, 'provider'> & { provider: CatalogProviderId };
export type CatalogQueueReference = RegisteredCatalogProvider['queues']['work'] | RegisteredCatalogProvider['queues']['deadLetter'];
export type CloudflareCatalogQueueBinding =
  | RegisteredCatalogProvider['runtime']['cloudflareWorkBinding']
  | RegisteredCatalogProvider['runtime']['cloudflareDeadLetterBinding'];
export type CloudflareCatalogQueueIdBinding = RegisteredCatalogProvider['runtime']['cloudflareQueueIdBinding'];

export const catalogProviderIds = Object.freeze(Object.keys(integrationRegistry) as CatalogProviderId[]);
export const catalogProviderDefinitions = Object.freeze(catalogProviderIds.map((id) => integrationRegistry[id]));

export function isCatalogProviderId(value: unknown): value is CatalogProviderId {
  return typeof value === 'string' && Object.hasOwn(integrationRegistry, value);
}

export function catalogProviderForSourceId(sourceId: string): CatalogProviderId | undefined {
  return catalogProviderDefinitions.find((provider) => provider.matchesSourceId(sourceId))?.id as CatalogProviderId | undefined;
}

export function isOfficialProviderSourceId(sourceId: string): boolean {
  const provider = catalogProviderForSourceId(sourceId);
  return provider !== undefined && integrationRegistry[provider].sourceAuthority === 'official-provider';
}

export function sourceProvider(sourceId: string): NonNullable<SourceHealth['provider']> {
  return catalogProviderForSourceId(sourceId) ?? 'unknown';
}

export function sourceRegion(provider: string | undefined): string {
  return isCatalogProviderId(provider) ? integrationRegistry[provider].defaultRegion : 'unknown';
}

export function operationsSources(context: OperationsSourceContext = {}): RegisteredOperationsSource[] {
  const sources: NormalizedOperationsSource[] = [];
  for (const provider of catalogProviderDefinitions) sources.push(...provider.operationsSources(context));
  return sources as RegisteredOperationsSource[];
}

export function providerForCloudflareCron(cron: string): CatalogProviderId | undefined {
  return catalogProviderDefinitions.find((provider) => provider.runtime.cloudflareCron === cron)?.id as CatalogProviderId | undefined;
}

export function providerForQueueName(queueName: string): CatalogProviderId | undefined {
  return catalogProviderDefinitions.find((provider) => (
    queueName === provider.id
    || queueName.endsWith(`-${provider.id}`)
    || queueName.endsWith(`-${provider.id}-dlq`)
  ))?.id as CatalogProviderId | undefined;
}
