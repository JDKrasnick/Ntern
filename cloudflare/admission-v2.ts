import { safeFetchText } from '../src/employer/index.js';
import { processAdmissionV2Message, type AdmissionV2MessageResult } from '../src/ingestion-v2/admission/consumer.js';
import { RuleBasedAdmissionV2Evaluator, type AdmissionDestinationProber, type AdmissionV2CatalogSink } from '../src/ingestion-v2/admission/evaluator.js';
import { validateAdmissionV2Message } from '../src/ingestion-v2/admission/message.js';
import { RecordingAdmissionV2CatalogSink } from '../src/ingestion-v2/admission/recording-sink.js';
import { AdmissionRowTransientError } from '../src/ingestion-v2/admission/taxonomy.js';
import { admissionV2FeatureConfig, type AdmissionV2RowEvaluator } from '../src/ingestion-v2/admission/types.js';
import { D1IngestionV2Repository, R2IngestionSnapshotStore } from './ingestion-v2-store.js';
import type { D1Database, MessageBatch, R2Bucket } from './types.js';

export interface AdmissionV2Environment {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  INGESTION_V2_ADMISSION_ENABLED?: string;
  INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST?: string;
}

interface HostResolver {
  resolve(hostname: string): Promise<string[]>;
}

/** Bounded destination probe over the reviewed public-network fetcher. */
export function cloudflareAdmissionProber(resolver: HostResolver): AdmissionDestinationProber {
  return {
    async probe({ applyUrl }) {
      let result;
      try {
        result = await safeFetchText(applyUrl, {
          resolver,
          timeoutMs: 8_000,
          maxRedirects: 2,
          maxBodyBytes: 256 * 1024,
          headers: { Accept: 'text/html,application/xhtml+xml' },
        });
      } catch (error) {
        // A refused, unresolved, or timed-out probe is row-local and retryable.
        throw new AdmissionRowTransientError('destination-timeout', error instanceof Error ? error.message : String(error));
      }
      if (result.status === 404 || result.status === 410) return { reachability: 'gone' };
      if (result.status === 429) throw new AdmissionRowTransientError('destination-rate-limited', `HTTP ${result.status}`);
      if (result.status >= 500) throw new AdmissionRowTransientError('upstream-server-error', `HTTP ${result.status}`);
      if (result.status >= 400) return { reachability: 'blocked' };
      return { reachability: 'live' };
    },
  };
}

/**
 * Stage 2 runs in verification mode: the catalog writer is replaced by a
 * recorded decision sink, so admission writes ledger state and captures the
 * decision it would have published without mutating the live catalog. Stage 3
 * cutover swaps the sink for the reconciler-backed writer.
 */
export function stage2AdmissionEvaluator(resolver: HostResolver, sink: AdmissionV2CatalogSink = new RecordingAdmissionV2CatalogSink()): AdmissionV2RowEvaluator {
  return new RuleBasedAdmissionV2Evaluator({ prober: cloudflareAdmissionProber(resolver), sink });
}

/**
 * Consume one admission delivery. Each message carries at most 25 external IDs;
 * every row settles, retries, or quarantines independently. Malformed work is
 * acknowledged (no dispatcher could reissue it); infrastructure failures are
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
      message.ack();
    }
    console.log(JSON.stringify({ event: 'ingestion_v2_admission_disabled_drain', messages: batch.messages.length }));
    return;
  }
  const snapshots = new R2IngestionSnapshotStore(env.DOCUMENTS);
  const evaluator = stage2AdmissionEvaluator(options.resolver, options.sink);
  const now = options.now ?? (() => new Date());
  const retryDelaySeconds = options.retryDelaySeconds ?? 60;
  for (const message of batch.messages) {
    const validated = validateAdmissionV2Message(message.body);
    if (!validated.ok) {
      console.error(JSON.stringify({ event: 'ingestion_v2_admission_malformed', messageId: message.id, reason: validated.reason }));
      message.ack();
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
      message.retry({ delaySeconds: retryDelaySeconds });
      continue;
    }
    if (result.acknowledged) {
      await ledger.acknowledgeHandoff(validated.message.batchId, now().toISOString());
      message.ack();
    } else {
      console.warn(JSON.stringify({
        event: 'ingestion_v2_admission_infrastructure_retry',
        messageId: message.id, batchId: validated.message.batchId,
        classification: result.infrastructureFailure?.classification,
      }));
      message.retry({ delaySeconds: retryDelaySeconds });
    }
  }
}

/** Whether the admission consumer should process a source's messages. */
export function admissionSourceAllowed(env: AdmissionV2Environment, sourceId: string): boolean {
  const allowlist = env.INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST?.split(',').map((entry) => entry.trim()).filter(Boolean);
  return !allowlist?.length || allowlist.includes(sourceId);
}
