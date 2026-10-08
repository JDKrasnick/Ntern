import { processAdmissionV2Batch, ADMISSION_V2_QUEUE_NAME } from './admission-v2.js';
import { AdmissionDispatchNotReady, runAdmissionV2Dispatch, type AdmissionDispatchEnvironment } from './admission-v2-dispatch.js';
import { admissionV2OwnsCatalogWrites } from '../src/ingestion-v2/admission/types.js';
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
    if (new URL(request.url).pathname === '/internal/dispatch') {
      if (request.method !== 'POST' || !isolationEnabled(env)) return new Response('Not found', { status: 404 });
      let body: { sourceId?: unknown };
      try {
        const text = await request.text();
        if (text.length > 1024) throw new Error('Oversized dispatch request');
        body = JSON.parse(text) as typeof body;
      } catch { return Response.json({ message: 'Invalid dispatch request' }, { status: 400 }); }
      if (!body || typeof body.sourceId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,199}$/u.test(body.sourceId)
        || Object.keys(body).length !== 1) return Response.json({ message: 'Explicit sourceId required' }, { status: 400 });
      if (!admissionV2OwnsCatalogWrites(env, body.sourceId)) return Response.json({ message: 'Source lacks matched V2 writer ownership' }, { status: 409 });
      if (await billingStopped(env.DB)) return new Response('Billing stopped', { status: 503 });
      try {
        return Response.json({ completed: true, sourceId: body.sourceId, ...await runDispatch(env, new Date(), body.sourceId) });
      } catch (error) {
        if (error instanceof AdmissionDispatchNotReady) return Response.json({ message: error.message }, { status: 409 });
        throw error;
      }
    }
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
  await runDispatch(env, new Date(event.scheduledTime));
}

async function runDispatch(env: AdmissionWorkerEnvironment, observedAt: Date, sourceId?: string) {
  const phases = new D1MaintenancePhaseStore(env.DB, sourceId ? `admission_v2_manual:${sourceId}` : 'admission_v2');
  await recordPhase(phases, 'dispatch', 'started', observedAt);
  try {
    const result = await runAdmissionV2Dispatch(env, observedAt, sourceId);
    await recordPhase(phases, 'dispatch', 'complete', observedAt);
    console.log(JSON.stringify({ event: sourceId ? 'cloudflare_admission_v2_manual_dispatch_complete' : 'cloudflare_admission_v2_dispatch_complete', ...(sourceId ? { sourceId } : {}), ...result }));
    return result;
  } catch (error) {
    await recordPhase(phases, 'dispatch', 'failed', observedAt);
    throw error;
  }
}
