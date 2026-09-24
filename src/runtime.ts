import { validateApplicationUrlWithEvidence, type ApplicationUrlValidator } from './core/application-url.js';
import { defaultPushTemplates, deliverDeferredExpoNotifications, ExpoPushPublisher, inspectExpoPushReceipts, NtfyPublisher, retryExpoPushNotifications, sendDigest, sendNewJobNotifications, sendPendingNotifications, type EmailSender, type PushPublisher } from './notifications.js';
import { Poller } from './poll.js';
import { type InternshipStore, type UserStore } from './store.js';
import { defaultSources } from './sources/index.js';
import type { SourceAdapter } from './types.js';
import type { CatalogAdmissionResolver, DestinationVerificationRequest } from './destination-verification.js';
import type { EmployerIconSeed } from './employer-icon-resolution.js';

export interface RuntimeConfig {
  /** Optional personal fallback topic. Public app alerts use Expo Push Service. */
  ntfyTopic?: string;
  ntfyEndpoint?: string;
  ntfyTitleTemplate?: string;
  ntfyDescriptionTemplate?: string;
  sesFrom: string;
  sesTo: string;
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
  /** Records a background company-icon task for an admitted employer. */
  enqueueEmployerIconResolution?: (seed: EmployerIconSeed) => Promise<void>;
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
      dependencies.enqueueEmployerIconResolution,
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
      const deferred = await deliverDeferredExpoNotifications(dependencies.store, dependencies.userStore, publisher);
      const pushRetries = await retryExpoPushNotifications(
        dependencies.store,
        dependencies.userStore,
        publisher,
        undefined,
        dependencies.groupedPipelineUserIds === '*'
          ? { excludeAllUsers: true }
          : { excludeUserIds: dependencies.groupedPipelineUserIds },
      );
      return { poll, notifications, ntfy, deferred, receipts, pushRetries };
    }
    if (dependencies.notificationPublisher) {
      const { sendPendingNotifications } = await import('./notifications.js');
      return { poll, notifications: await sendPendingNotifications(dependencies.store, dependencies.notificationPublisher) };
    }
    return { poll, notifications: { sent: 0, skipped: 0, failed: 0 } };
  }
  if (!dependencies.emailSender) throw new Error('An EmailSender is required for digest delivery');
  return { digested: await sendDigest(dependencies.store, dependencies.emailSender) };
}
