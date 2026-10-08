import { D1InternshipStore } from './d1-store.js';
import { D1MaintenancePhaseStore } from './maintenance-phases.js';
import { recordPhase, refreshCatalogProjectionD1, refreshCatalogProjectionR2, runCatalogProjectionMaintenance } from './catalog-projection-maintenance.js';
import { publishProspectiveShadowMetadata } from './shadow-publication.js';
import { billingStopped, isolationEnabled } from './isolated-work.js';
import { isolatedScheduleRequest } from './isolated-schedule.js';
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
    if (await billingStopped(env.DB)) return new Response('Billing stopped', { status: 503 });
    await runScheduled(event, env);
    return Response.json({ completed: true });
  },
  // Old registrations must not duplicate the established ingestion cron's call.
  async scheduled(): Promise<void> {},
};

async function runScheduled(event: ScheduledController, env: CatalogPublisherEnvironment): Promise<void> {
  const observedAt = new Date(event.scheduledTime);
  const store = new D1InternshipStore(env.DB);
  if (event.cron === '1-51/10 * * * *' || event.cron === '1,11,21,31,41,51 * * * *') {
    const phases = new D1MaintenancePhaseStore(env.DB, 'catalog_projection');
    const result = await runCatalogProjectionMaintenance(
      (refresh) => publishProspectiveShadowMetadata(env, refresh),
      () => refreshCatalogProjectionD1(store, env.DOCUMENTS, phases), phases);
    if (!result.projection) throw new Error('D1 catalog projection failed');
    await recordPhase(phases, 'catalog_projection_complete', 'complete', observedAt);
    console.log(JSON.stringify({ event: 'cloudflare_catalog_projection_complete', observedAt: observedAt.toISOString(), ...result }));
  } else if (event.cron === '5,15,25,35,45,55 * * * *' || event.cron === '4,14,24,34,44,54 * * * *' || event.cron === '4-54/10 * * * *') {
    const phases = new D1MaintenancePhaseStore(env.DB, 'catalog_projection_r2');
    const projection = await refreshCatalogProjectionR2(store, env.DOCUMENTS, phases);
    await recordPhase(phases, 'catalog_projection_r2_complete', 'complete', observedAt);
    console.log(JSON.stringify({ event: 'cloudflare_catalog_projection_r2_complete', observedAt: observedAt.toISOString(), projection }));
  }
}
