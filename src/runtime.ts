import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { auditCatalogIndexes, emitCatalogIndexAuditMetric } from './catalog-index-audit.js';
import { validateApplicationUrlWithEvidence, type ApplicationUrlValidator } from './core/application-url.js';
import { defaultPushTemplates, ExpoPushPublisher, inspectExpoPushReceipts, NtfyPublisher, retryExpoPushNotifications, sendDigest, sendNewJobNotifications, sendPendingNotifications, SesEmailSender, type EmailSender, type PushPublisher } from './notifications.js';
import { Poller } from './poll.js';
import { DynamoInternshipStore, DynamoUserStore, type InternshipStore, type UserStore } from './store.js';
import { defaultSources } from './sources/index.js';
import type { SourceAdapter } from './types.js';
import { catalogGroupDetails, groupCatalogJobs } from './catalog-groups.js';
import { loadGroupedNotificationCohort } from './grouped-notification-cohort.js';
import type { CatalogAdmissionResolver, DestinationVerificationRequest } from './destination-verification.js';

export interface RuntimeConfig {
  /** Optional personal fallback topic. Public app alerts use Expo Push Service. */
  ntfyTopic?: string;
  ntfyEndpoint?: string;
  ntfyTitleTemplate?: string;
  ntfyDescriptionTemplate?: string;
  sesFrom: string;
  sesTo: string;
}

export async function loadRuntimeConfig(parameterName: string, client = new SSMClient({})): Promise<RuntimeConfig> {
  const value = (await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }))).Parameter?.Value;
  if (!value) throw new Error(`Runtime configuration parameter ${parameterName} has no value`);
  const config = JSON.parse(value) as Partial<RuntimeConfig>;
  if (!config.sesFrom || !config.sesTo) throw new Error('Runtime configuration requires sesFrom and sesTo');
  return config as RuntimeConfig;
}

export interface RuntimeDependencies {
  store: InternshipStore;
  config: RuntimeConfig;
  sources?: SourceAdapter[];
  userStore?: UserStore;
  expoPublisher?: ExpoPushPublisher;
  /** Legacy test/CLI injection. */
  notificationPublisher?: PushPublisher;
  ntfyPublisher?: PushPublisher;
  emailSender?: EmailSender;
  /** Replaces live URL verification in deterministic tests. */
  linkValidator?: ApplicationUrlValidator;
  /** Owner cohort excluded from legacy delivery while the grouped pipeline is measured. */
  groupedPipelineUserIds?: ReadonlySet<string> | '*';
  /** Per-source queue runs already validate their incoming listings. */
  validateCatalogOnPoll?: boolean;
  /** Reviewed complete sources may close their final role with an explicit empty snapshot. */
  allowCompleteEmptySnapshot?: boolean;
  /** Bounds resumable GitHub admission migration work in one queue delivery. */
  maxAdmissionMigrationListingsPerSourceRun?: number;
  /** Bounds listings resolved in one queue delivery; the remainder resumes from the checkpoint. */
  maxListingsPerSourceRun?: number;
  enqueueDestinationVerification?: (request: DestinationVerificationRequest) => Promise<void>;
  catalogAdmissionResolver?: CatalogAdmissionResolver;
  /** Defaults off in deployed runtimes until the compatible client is live. */
  identityUnconfirmedPublicationEnabled?: boolean;
  /** Catalog exposure gate; alert activation stays in reviewed source policy. */
  trustedCommunityCatalogEnabled?: boolean;
}

export async function runRuntimeCommand(command: 'poll' | 'digest', dependencies: RuntimeDependencies) {
  if (command === 'poll') {
    const poll = await new Poller(
      dependencies.sources ?? defaultSources,
      dependencies.store,
      undefined,
      undefined,
      dependencies.linkValidator ?? validateApplicationUrlWithEvidence,
      dependencies.validateCatalogOnPoll === false ? false : undefined,
      dependencies.enqueueDestinationVerification,
      dependencies.catalogAdmissionResolver,
      dependencies.identityUnconfirmedPublicationEnabled ?? false,
      dependencies.trustedCommunityCatalogEnabled ?? false,
    ).poll({
      allowCompleteEmptySnapshot: dependencies.allowCompleteEmptySnapshot,
      maxAdmissionMigrationListingsPerSourceRun: dependencies.maxAdmissionMigrationListingsPerSourceRun,
      maxListingsPerSourceRun: dependencies.maxListingsPerSourceRun,
    });
    if (dependencies.userStore) {
      const publisher = dependencies.expoPublisher ?? new ExpoPushPublisher();
      const templates = { ...defaultPushTemplates, titleTemplate: dependencies.config.ntfyTitleTemplate ?? defaultPushTemplates.titleTemplate, descriptionTemplate: dependencies.config.ntfyDescriptionTemplate ?? defaultPushTemplates.descriptionTemplate };
      const ntfy = dependencies.config.ntfyTopic
        ? await sendPendingNotifications(dependencies.store, dependencies.ntfyPublisher ?? new NtfyPublisher(dependencies.config.ntfyTopic, dependencies.config.ntfyEndpoint), templates)
        : { sent: 0, failed: 0 };
      const notifications = await sendNewJobNotifications(
        poll.newJobs.filter((job) => job.technical !== false), dependencies.userStore, publisher,
        undefined, undefined,
        dependencies.groupedPipelineUserIds === '*'
          ? { excludeAllUsers: true }
          : { excludeUserIds: dependencies.groupedPipelineUserIds },
      );
      const receipts = await inspectExpoPushReceipts(dependencies.userStore, publisher);
      const pushRetries = await retryExpoPushNotifications(
        dependencies.store,
        dependencies.userStore,
        publisher,
        undefined,
        dependencies.groupedPipelineUserIds === '*'
          ? { excludeAllUsers: true }
          : { excludeUserIds: dependencies.groupedPipelineUserIds },
      );
      return { poll, notifications, ntfy, receipts, pushRetries };
    }
    if (dependencies.notificationPublisher) {
      const { sendPendingNotifications } = await import('./notifications.js');
      return { poll, notifications: await sendPendingNotifications(dependencies.store, dependencies.notificationPublisher) };
    }
    return { poll, notifications: { sent: 0, skipped: 0, failed: 0 } };
  }
  return { digested: await sendDigest(dependencies.store, dependencies.emailSender ?? new SesEmailSender(dependencies.config.sesFrom, dependencies.config.sesTo)) };
}

export async function runtimeHandler(event: { command?: string } = {}) {
  const command = event.command;
  if (command !== 'poll' && command !== 'digest' && command !== 'audit-catalog-indexes' && command !== 'refresh-catalog-groups') throw new Error('Scheduler event command must be poll, digest, audit-catalog-indexes, or refresh-catalog-groups');
  const tableName = process.env.INTERNSHIPS_TABLE;
  if (!tableName) throw new Error('INTERNSHIPS_TABLE is required');
  if (command === 'audit-catalog-indexes') {
    const result = await auditCatalogIndexes(tableName, DynamoDBDocumentClient.from(new DynamoDBClient({})));
    emitCatalogIndexAuditMetric(result);
    return result;
  }
  if (command === 'refresh-catalog-groups') {
    const store = new DynamoInternshipStore(tableName);
    const groups = groupCatalogJobs(await store.listCatalog(), { includeClosed: true }).map(catalogGroupDetails);
    const generatedAt = new Date().toISOString();
    await store.putCatalogProjection?.(groups, generatedAt);
    return { generatedAt, groups: groups.length, roles: groups.reduce((total, group) => total + group.roles.length, 0) };
  }
  const parameterName = process.env.RUNTIME_CONFIG_PARAMETER_NAME;
  const usersTable = process.env.USERS_TABLE;
  if (!parameterName || !usersTable) throw new Error('USERS_TABLE and RUNTIME_CONFIG_PARAMETER_NAME are required');
  const cohortParameterName = process.env.GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME;
  if (!cohortParameterName) throw new Error('GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME is required');
  const cohort = await loadGroupedNotificationCohort(cohortParameterName);
  const result = await runRuntimeCommand(command, {
    store: new DynamoInternshipStore(tableName), userStore: new DynamoUserStore(usersTable), config: await loadRuntimeConfig(parameterName),
    groupedPipelineUserIds: cohort,
    identityUnconfirmedPublicationEnabled: process.env.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED === 'true',
    trustedCommunityCatalogEnabled: process.env.TRUSTED_COMMUNITY_CATALOG_ENABLED === 'true',
  });
  console.log(JSON.stringify({ command, ...result }));
  return result;
}
