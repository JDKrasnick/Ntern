import { D1InternshipStore } from './d1-store.js';
import { D1MaintenancePhaseStore } from './maintenance-phases.js';
import { recordPhase, refreshCatalogProjectionD1, refreshCatalogProjectionR2, runCatalogProjectionMaintenance } from './catalog-projection-maintenance.js';
import { publishProspectiveShadowMetadata } from './shadow-publication.js';
import { billingStopped, isolationEnabled } from './isolated-work.js';
import { isolatedScheduleRequest } from './isolated-schedule.js';
import { isR2InternalFailure } from './r2-errors.js';
import { classifyD1Failure } from './d1-errors.js';
import type { D1Database, R2Bucket, ScheduledController } from './types.js';

export interface CatalogPublisherEnvironment {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  SHADOW_EXTRACTION_ARTIFACTS: R2Bucket;
  LLM_METADATA_PUBLICATION_POLICY_JSON?: string;
  INGESTION_V2_ISOLATED_WORKERS_ENABLED?: string;
}

export default {
  async fetch(request: Request, env: CatalogPublisherEnvironment): Promise<Response> {
    const event = await isolatedScheduleRequest(request, ['1,11,21,31,41,51 * * * *', '5,15,25,35,45,55 * * * *', '1-51/10 * * * *', '4,14,24,34,44,54 * * * *', '4-54/10 * * * *']);
    if (!event || !isolationEnabled(env)) return new Response('Not found', { status: 404 });
    try {
      if (await billingStopped(env.DB)) return new Response('Billing stopped', { status: 503 });
      await runProtectedSchedule(event, env);
    } catch (error) {
      const failureClass = await deferPublicationFailure(error, event, env);
      if (!failureClass) throw error;
      return Response.json({ completed: false, deferred: true, failureClass },
        { status: 503, headers: { 'Retry-After': '600' } });
    }
    return Response.json({ completed: true });
  },
  // Cloudflare may retain native deliveries after the registration moves. Keep
  // publication live through that transition; a shared phase lease and existing
  // pointer fences protect both native and private-binding invocations.
  async scheduled(event: ScheduledController, env: CatalogPublisherEnvironment): Promise<void> {
    if (!isolationEnabled(env)) return;
    try {
      if (await billingStopped(env.DB)) return;
      await runProtectedSchedule(event, env);
    } catch (error) {
      if (!await deferPublicationFailure(error, event, env)) throw error;
    }
  },
};

async function deferPublicationFailure(error: unknown, event: ScheduledController, env: CatalogPublisherEnvironment): Promise<string | undefined> {
  const d1 = classifyD1Failure(error);
  const failureClass = isR2InternalFailure(error) ? 'r2-internal'
    : d1 === 'overloaded' ? 'd1-overloaded' : d1 === 'internal' ? 'd1-internal' : undefined;
  if (!failureClass) return undefined;
  const scope = ['1-51/10 * * * *', '1,11,21,31,41,51 * * * *'].includes(event.cron)
    ? 'catalog_projection' : 'catalog_projection_r2';
  await recordPhase(new D1MaintenancePhaseStore(env.DB, scope), scope, 'failed');
  // Rebuild on the next cadence. Retrying a conditional pointer write here
  // could turn a lost successful acknowledgement into a precondition miss.
  console.warn(JSON.stringify({ event: 'cloudflare_catalog_projection_deferred',
    cron: event.cron, failureClass, retryAfterSeconds: 600 }));
  return failureClass;
}

async function runProtectedSchedule(event: ScheduledController, env: CatalogPublisherEnvironment): Promise<void> {
  const key = 'maintenance_lease:catalog_publisher';
  const owner = crypto.randomUUID();
  const now = Date.now();
  // Both entry points originate from cron work with a 15-minute wall limit.
  // Keep the lease beyond that limit so a killed invocation expires safely.
  const lease = await env.DB.prepare(`INSERT INTO system_state (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    WHERE json_extract(system_state.value,'$.expiresAt') <= ?`)
    .bind(key, JSON.stringify({ owner, expiresAt: now + 16 * 60_000 }), new Date(now).toISOString(), now).run();
  if (lease.meta.changes !== 1) {
    console.log(JSON.stringify({ event: 'cloudflare_catalog_projection_lease_busy', cron: event.cron }));
    return;
  }
  try {
    await runScheduled(event, env);
  } finally {
    await env.DB.prepare("DELETE FROM system_state WHERE key=? AND json_extract(value,'$.owner')=?").bind(key, owner).run();
  }
}

async function runScheduled(event: ScheduledController, env: CatalogPublisherEnvironment): Promise<void> {
  const observedAt = new Date(event.scheduledTime);
  const store = new D1InternshipStore(env.DB);
  if (event.cron === '1-51/10 * * * *' || event.cron === '1,11,21,31,41,51 * * * *') {
    const phases = new D1MaintenancePhaseStore(env.DB, 'catalog_projection');
    let projectionFailure: unknown;
    const result = await runCatalogProjectionMaintenance(
      (refresh) => publishProspectiveShadowMetadata(env, refresh),
      () => refreshCatalogProjectionD1(store, env.DOCUMENTS, phases).catch(error => {
        projectionFailure = error;
        throw error;
      }), phases);
    if (!result.projection) {
      if (isR2InternalFailure(projectionFailure) || ['overloaded', 'internal'].includes(classifyD1Failure(projectionFailure))) throw projectionFailure;
      throw new Error('D1 catalog projection failed');
    }
    await recordPhase(phases, 'catalog_projection_complete', 'complete', observedAt);
    console.log(JSON.stringify({ event: 'cloudflare_catalog_projection_complete', observedAt: observedAt.toISOString(), ...result }));
  } else if (event.cron === '5,15,25,35,45,55 * * * *' || event.cron === '4,14,24,34,44,54 * * * *' || event.cron === '4-54/10 * * * *') {
    const phases = new D1MaintenancePhaseStore(env.DB, 'catalog_projection_r2');
    const projection = await refreshCatalogProjectionR2(store, env.DOCUMENTS, phases);
    await recordPhase(phases, 'catalog_projection_r2_complete', 'complete', observedAt);
    console.log(JSON.stringify({ event: 'cloudflare_catalog_projection_r2_complete', observedAt: observedAt.toISOString(), projection }));
  }
}
