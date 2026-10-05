import { PublicNetworkPolicyError, safeFetchText } from '../src/employer/index.js';
import { applicationPageEvidenceFromHtml, ApplicationUrlValidationError } from '../src/core/application-url.js';
import { processAdmissionV2Message, type AdmissionV2MessageResult } from '../src/ingestion-v2/admission/consumer.js';
import { RuleBasedAdmissionV2Evaluator, type AdmissionCanonicalEmployerResolver, type AdmissionDestinationProber, type AdmissionV2CatalogSink, type AdmissionV2PriorContextResolver } from '../src/ingestion-v2/admission/evaluator.js';
import { validateAdmissionV2Message } from '../src/ingestion-v2/admission/message.js';
import { RecordingAdmissionV2CatalogSink } from '../src/ingestion-v2/admission/recording-sink.js';
import { ReconcilerAdmissionV2CatalogSink } from '../src/ingestion-v2/admission/catalog-sink.js';
import { AdmissionRowTransientError } from '../src/ingestion-v2/admission/taxonomy.js';
import { admissionV2FeatureConfig, admissionV2OwnsCatalogWrites, admissionV2TrustedCommunityAlertsAllowed, type AdmissionV2RowEvaluator } from '../src/ingestion-v2/admission/types.js';
import { D1IngestionV2Repository, R2IngestionSnapshotStore } from './ingestion-v2-store.js';
import { D1RecordingAdmissionV2CatalogSink } from './admission-v2-recording-sink.js';
import { D1CatalogAdmissionStore } from './catalog-admission-store.js';
import { D1InternshipStore } from './d1-store.js';
import { recordQueueFailureBestEffort, resolveQueueFailures } from './dlq-operations.js';
import type { D1Database, MessageBatch, R2Bucket } from './types.js';

export const ADMISSION_V2_QUEUE_NAME = 'intern-notifs-admission-v2';

export interface AdmissionV2Environment {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  INGESTION_V2_SHADOW_DISCOVERY_ENABLED?: string;
  INGESTION_V2_SHADOW_SOURCE_ALLOWLIST?: string;
  INGESTION_V2_ADMISSION_ENABLED?: string;
  INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST?: string;
  INGESTION_V2_CATALOG_WRITER_ENABLED?: string;
  INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST?: string;
  INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST?: string;
  INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST?: string;
  TRUSTED_COMMUNITY_CATALOG_ENABLED?: string;
}

interface HostResolver {
  resolve(hostname: string): Promise<string[]>;
}

/** Bounded destination probe over the reviewed public-network fetcher. */
export function cloudflareAdmissionProber(resolver: HostResolver): AdmissionDestinationProber {
  const maximumEvidenceBytes = 128 * 1024;
  return {
    async probe({ applyUrl }) {
      let result;
      try {
        result = await safeFetchText(applyUrl, {
          resolver,
          timeoutMs: 8_000,
          maxRedirects: 2,
          // Retain enough bounded server-rendered evidence for nonstandard
          // official forms while keeping large careers pages resource-safe.
          maxBodyBytes: maximumEvidenceBytes,
          onOversize: 'truncate',
          headers: { Accept: 'text/html,application/xhtml+xml' },
        });
      } catch (error) {
        // A policy refusal remains fail-closed and cannot improve by retrying.
        // DNS/transport failures remain retryable and consume the row budget.
        if (error instanceof PublicNetworkPolicyError) return { reachability: 'blocked' };
        throw new AdmissionRowTransientError('destination-timeout', error instanceof Error ? error.message : String(error));
      }
      if (result.status === 404 || result.status === 410) return { reachability: 'gone' };
      if (result.status === 429) throw new AdmissionRowTransientError('destination-rate-limited', `HTTP ${result.status}`);
      if (result.status >= 500) throw new AdmissionRowTransientError('upstream-server-error', `HTTP ${result.status}`);
      if (result.status >= 400) return { reachability: 'blocked' };
      const inspectedBytes = new TextEncoder().encode(result.body).byteLength;
      const declaredBytes = Number(result.headers.get('content-length'));
      try {
        return {
          reachability: 'live',
          evidence: applicationPageEvidenceFromHtml({
            requestedUrl: applyUrl,
            finalUrl: result.url,
            html: result.body,
            inspectedBytes,
            inspectionTruncated: inspectedBytes >= maximumEvidenceBytes
              || (Number.isFinite(declaredBytes) && declaredBytes > inspectedBytes),
          }),
        };
      } catch (error) {
        if (error instanceof ApplicationUrlValidationError) return { reachability: 'gone' };
        throw error;
      }
    },
  };
}

/**
 * Stage 2 runs in verification mode: the catalog writer is replaced by a
 * recorded decision sink, so admission writes ledger state and captures the
 * decision it would have published without mutating the live catalog. Stage 3
 * cutover swaps the sink for the reconciler-backed writer.
 */
export function stage2AdmissionEvaluator(
  resolver: HostResolver,
  sink: AdmissionV2CatalogSink = new RecordingAdmissionV2CatalogSink(),
  resolveCanonicalEmployer?: AdmissionCanonicalEmployerResolver,
  options: {
    resolvePriorContext?: AdmissionV2PriorContextResolver;
    trustedCommunityCatalogEnabled?: boolean;
    trustedCommunityAlertsEnabledForSource?: (sourceId: string) => boolean;
  } = {},
): AdmissionV2RowEvaluator {
  return new RuleBasedAdmissionV2Evaluator({
    prober: cloudflareAdmissionProber(resolver),
    sink,
    ...(resolveCanonicalEmployer ? { resolveCanonicalEmployer } : {}),
    ...(options.resolvePriorContext ? { resolvePriorContext: options.resolvePriorContext } : {}),
    trustedCommunityCatalogEnabled: options.trustedCommunityCatalogEnabled ?? false,
    ...(options.trustedCommunityAlertsEnabledForSource
      ? { trustedCommunityAlertsEnabledForSource: options.trustedCommunityAlertsEnabledForSource }
      : {}),
  });
}

/**
 * Consume one admission delivery. Each message carries at most 25 external IDs;
 * every row settles, retries, or quarantines independently. Malformed work is
 * ledgered and sent through platform retries/DLQ; infrastructure failures are
 * retried without consuming a row attempt; transient/terminal results are
 * acknowledged after every peer row has committed.
 */
export async function processAdmissionV2Batch(
  batch: MessageBatch<unknown>,
  env: AdmissionV2Environment,
  options: { resolver: HostResolver; sink?: AdmissionV2CatalogSink; now?: () => Date; retryDelaySeconds?: number },
): Promise<void> {
  const ledger = new D1IngestionV2Repository(env.DB);
  if (!admissionV2FeatureConfig(env).admissionEnabled) {
    const now = options.now ?? (() => new Date());
    for (const message of batch.messages) {
      const validated = validateAdmissionV2Message(message.body);
      if (validated.ok) await ledger.acknowledgeHandoff(validated.message.batchId, now().toISOString());
      await resolveQueueFailures(env.DB, ADMISSION_V2_QUEUE_NAME, message.id, now());
      message.ack();
    }
    console.log(JSON.stringify({ event: 'ingestion_v2_admission_disabled_drain', messages: batch.messages.length }));
    return;
  }
  const snapshots = new R2IngestionSnapshotStore(env.DOCUMENTS);
  const now = options.now ?? (() => new Date());
  const admissionStore = new D1CatalogAdmissionStore(env.DB);
  const internshipStore = new D1InternshipStore(env.DB);
  const evaluator = stage2AdmissionEvaluator(
    options.resolver,
    options.sink ?? {
      async revoke(input) {
        if (!admissionV2OwnsCatalogWrites(env, input.sourceId)) return;
        await new ReconcilerAdmissionV2CatalogSink(internshipStore, now).revoke(input);
      },
      async commit(input) {
        const sink = admissionV2OwnsCatalogWrites(env, input.sourceId)
          ? new ReconcilerAdmissionV2CatalogSink(internshipStore, now)
          : new D1RecordingAdmissionV2CatalogSink(env.DB, now);
        await sink.commit(input);
      },
    },
    async (listing) => listing.providerIdentity
      ? admissionStore.resolveCanonicalEmployer(listing.providerIdentity)
      : undefined,
    {
      trustedCommunityCatalogEnabled: env.TRUSTED_COMMUNITY_CATALOG_ENABLED === 'true',
      trustedCommunityAlertsEnabledForSource: (sourceId) => admissionV2TrustedCommunityAlertsAllowed(env, sourceId),
      resolvePriorContext: async (sourceId, externalId) => {
        const prior = await internshipStore.getSourceOccurrence(sourceId, externalId);
        if (!prior) return undefined;
        return {
          ...(prior.occurrence.admission ? { admission: prior.occurrence.admission } : {}),
          ...(prior.occurrence.postingIdentityDecision
            ? { postingIdentityDecision: prior.occurrence.postingIdentityDecision }
            : {}),
          ...(prior.occurrence.trustedCommunityAlertQualification
            ? { trustedCommunityAlertQualification: prior.occurrence.trustedCommunityAlertQualification }
            : {}),
        };
      },
    },
  );
  const retryDelaySeconds = options.retryDelaySeconds ?? 60;
  for (const message of batch.messages) {
    const validated = validateAdmissionV2Message(message.body);
    if (!validated.ok) {
      console.error(JSON.stringify({ event: 'ingestion_v2_admission_malformed', messageId: message.id, reason: validated.reason }));
      const failure = new Error(`Malformed admission-v2 message: ${validated.reason}`);
      await recordQueueFailureBestEffort({
        db: env.DB, queueName: ADMISSION_V2_QUEUE_NAME, messageId: message.id,
        attempts: message.attempts, timestamp: message.timestamp, body: message.body,
        error: failure, now: now(),
      });
      message.retry({ delaySeconds: retryDelaySeconds }, failure);
      continue;
    }
    if (!admissionSourceAllowed(env, validated.message.sourceId)) {
      message.ack();
      continue;
    }
    let result: AdmissionV2MessageResult;
    try {
      result = await processAdmissionV2Message(validated.message, { ledger, snapshots, evaluator, ...(options.now ? { now: options.now } : {}) });
    } catch (error) {
      console.error(JSON.stringify({ event: 'ingestion_v2_admission_retry', messageId: message.id, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }));
      await recordQueueFailureBestEffort({
        db: env.DB, queueName: ADMISSION_V2_QUEUE_NAME, messageId: message.id,
        attempts: message.attempts, timestamp: message.timestamp, sourceId: validated.message.sourceId,
        sourceKind: 'ingestion-v2-admission', body: message.body, error, now: now(),
      });
      message.retry({ delaySeconds: retryDelaySeconds }, error);
      continue;
    }
    if (result.acknowledged) {
      await ledger.acknowledgeHandoff(validated.message.batchId, now().toISOString());
      await resolveQueueFailures(env.DB, ADMISSION_V2_QUEUE_NAME, message.id, now());
      message.ack();
    } else {
      console.warn(JSON.stringify({
        event: 'ingestion_v2_admission_infrastructure_retry',
        messageId: message.id, batchId: validated.message.batchId,
        classification: result.infrastructureFailure?.classification,
      }));
      const failure = new Error(result.infrastructureFailure?.classification ?? 'admission-v2 infrastructure failure');
      await recordQueueFailureBestEffort({
        db: env.DB, queueName: ADMISSION_V2_QUEUE_NAME, messageId: message.id,
        attempts: message.attempts, timestamp: message.timestamp, sourceId: validated.message.sourceId,
        sourceKind: 'ingestion-v2-admission', body: message.body, error: failure, now: now(),
      });
      message.retry({ delaySeconds: retryDelaySeconds }, failure);
    }
  }
}

/** Whether the admission consumer should process a source's messages. */
export function admissionSourceAllowed(env: AdmissionV2Environment, sourceId: string): boolean {
  const allowlist = env.INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST?.split(',').map((entry) => entry.trim()).filter(Boolean);
  return !allowlist?.length || allowlist.includes(sourceId);
}
