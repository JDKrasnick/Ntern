import { classifyD1Failure } from './d1-errors.js';
import type { ControllerOutcome, ControllerStatus, Permit, PipelinePriority } from './d1-traffic-controller.js';
import type { DurableObjectNamespace, MessageBatch } from './types.js';

interface AcquireResponse { permit?: Permit; retryAfterSeconds?: number; status: ControllerStatus; }

export interface D1TrafficObservation {
  complete(outcome: ControllerOutcome, error?: unknown): Promise<void>;
}

function log(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...details }));
}

/**
 * Observes one real D1-backed queue delivery without changing its queue semantics.
 * The Durable Object is deliberately fail-open until a later owner-reviewed
 * enforcement rollout makes permit refusal actionable.
 */
export async function observeD1Delivery(input: {
  controller?: DurableObjectNamespace;
  workload: string;
  queue: string;
  messageId: string;
  priority?: PipelinePriority;
  details?: Record<string, unknown>;
}): Promise<D1TrafficObservation | undefined> {
  if (!input.controller) return undefined;
  const priority = input.priority ?? 'P0';
  const { workload } = input;
  const details = { ...input.details, queue: input.queue, messageId: input.messageId, workload, priority };
  try {
    const stub = input.controller.get(input.controller.idFromName('catalog-ingestion'));
    const acquired = await stub.fetch('https://d1-traffic-controller/acquire', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workload, priority, messageId: input.messageId, runId: input.queue }),
    });
    if (!acquired.ok) throw new Error(`permit acquire returned ${acquired.status}`);
    const response = await acquired.json() as AcquireResponse;
    if (!response.permit) {
      log('d1_traffic_observation_unavailable', { ...details, mode: response.status.mode, retryAfterSeconds: response.retryAfterSeconds });
      return undefined;
    }
    log('d1_traffic_permit_acquired', { ...details, mode: response.status.mode, permitsInUse: response.status.permitsInUse,
      budgets: response.status.budgets, recentPressure: response.status.recentPressure });
    const startedAt = Date.now();
    let settled = false;
    return {
      async complete(outcome, error) {
        if (settled) return;
        settled = true;
        try {
          const completed = await stub.fetch('https://d1-traffic-controller/complete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ permitId: response.permit!.permitId, outcome, latencyMs: Date.now() - startedAt,
              ...(error === undefined ? {} : { d1FailureClass: classifyD1Failure(error) }) }),
          });
          if (!completed.ok) throw new Error(`permit complete returned ${completed.status}`);
          const status = await completed.json() as ControllerStatus;
          log('d1_traffic_permit_completed', { ...details, outcome, latencyMs: Date.now() - startedAt, mode: status.mode,
            permitsInUse: status.permitsInUse, budgets: status.budgets, recentPressure: status.recentPressure,
            ...(error === undefined ? {} : { d1FailureClass: classifyD1Failure(error) }) });
        } catch (completionError) {
          console.error(JSON.stringify({ event: 'd1_traffic_observation_failed', phase: 'complete', ...details,
            error: completionError instanceof Error ? completionError.message : String(completionError) }));
        }
      },
    };
  } catch (error) {
    console.error(JSON.stringify({ event: 'd1_traffic_observation_failed', phase: 'acquire', ...details,
      error: error instanceof Error ? error.message : String(error) }));
    return undefined;
  }
}

/**
 * Observes every delivery in one batch and completes its permits from the
 * consumer's own decision. `ack` and `retry` still call the real messages, so
 * queue semantics never change; the wrapper only records which one the consumer
 * chose and the failure that made it retry.
 *
 * Completion runs in a `finally`: a consumer that throws would otherwise hold
 * every permit in the batch until the controller's lease expires, and the whole
 * batch's outcome would go unrecorded.
 */
export async function observeQueueBatch<T>(
  batch: MessageBatch<unknown>,
  observations: Map<string, D1TrafficObservation | undefined>,
  consume: (observed: MessageBatch<unknown>) => Promise<T>,
): Promise<T> {
  const outcomes = new Map<string, ControllerOutcome>();
  const failures = new Map<string, unknown>();
  const observed: MessageBatch<unknown> = {
    ...batch,
    messages: batch.messages.map((message) => ({
      ...message,
      ack: () => { outcomes.set(message.id, 'success'); message.ack(); },
      retry: (options, failure) => {
        outcomes.set(message.id, 'failure');
        if (failure !== undefined) failures.set(message.id, failure);
        message.retry(options);
      },
    })),
  };
  try {
    return await consume(observed);
  } finally {
    await Promise.all(batch.messages.map((message) => observations.get(message.id)
      ?.complete(outcomes.get(message.id) ?? 'cancelled', failures.get(message.id))));
  }
}
