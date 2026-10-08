import { processAdmissionV2Batch, ADMISSION_V2_QUEUE_NAME } from './admission-v2.js';
import { runAdmissionV2Dispatch, type AdmissionDispatchEnvironment } from './admission-v2-dispatch.js';
import { billingStopped, isolationEnabled } from './isolated-work.js';
import { D1MaintenancePhaseStore, recordPhase } from './maintenance-phases.js';
import { publicHostResolver } from './public-host-resolver.js';
import { isolatedScheduleRequest } from './isolated-schedule.js';
import type { MessageBatch, ScheduledController } from './types.js';

export interface AdmissionWorkerEnvironment extends AdmissionDispatchEnvironment {
  INGESTION_V2_ISOLATED_WORKERS_ENABLED?: string;
  ADMISSION_V2_QUEUE_NAME?: string;
}

export default {
  async fetch(request: Request, env: AdmissionWorkerEnvironment): Promise<Response> {
    const event = await isolatedScheduleRequest(request, ['9-59/10 * * * *']);
    if (!event || !isolationEnabled(env)) return new Response('Not found', { status: 404 });
    if (await billingStopped(env.DB)) return new Response('Billing stopped', { status: 503 });
    await runScheduled(event, env);
    return Response.json({ completed: true });
  },
  // Retain a no-op handler while removed cron registrations propagate.
  async scheduled(): Promise<void> {},
  async queue(batch: MessageBatch<unknown>, env: AdmissionWorkerEnvironment): Promise<void> {
    if (batch.queue !== (env.ADMISSION_V2_QUEUE_NAME ?? ADMISSION_V2_QUEUE_NAME)) throw new Error('Unexpected admission queue');
    if (!isolationEnabled(env)) { for (const message of batch.messages) message.retry({ delaySeconds: 60 }); return; }
    if (await billingStopped(env.DB)) { for (const message of batch.messages) message.ack(); return; }
    await processAdmissionV2Batch(batch, env, { resolver: publicHostResolver });
  },
};

async function runScheduled(event: ScheduledController, env: AdmissionWorkerEnvironment): Promise<void> {
  const observedAt = new Date(event.scheduledTime);
  const phases = new D1MaintenancePhaseStore(env.DB, 'admission_v2');
  await recordPhase(phases, 'dispatch', 'started', observedAt);
  try {
    const result = await runAdmissionV2Dispatch(env, observedAt);
    await recordPhase(phases, 'dispatch', 'complete', observedAt);
    console.log(JSON.stringify({ event: 'cloudflare_admission_v2_dispatch_complete', ...result }));
  } catch (error) {
    await recordPhase(phases, 'dispatch', 'failed', observedAt);
    throw error;
  }
}
