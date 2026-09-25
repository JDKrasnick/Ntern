import legacyWorker, { provideIconSvgRasterizer, type Environment } from './worker.js';
import { rasterizeSvgIcon } from './svg-raster-wasm.js';
import { secretMatches } from './split.js';
export { D1TrafficController } from './d1-traffic-controller.js';

// This entry owns the icon sweep, so it is the one that can carry the rasterizer.
provideIconSvgRasterizer(rasterizeSvgIcon);

export interface IngestionEnvironment extends Partial<Environment> {
  INTERNAL_SERVICE_SECRET: string;
  DEPLOYMENT_ROLE?: string;
  VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
}

export default {
  async fetch(request: Request, env: IngestionEnvironment): Promise<Response> {
    if (!secretMatches(request.headers.get('X-InternNotifs-Service-Key'), env.INTERNAL_SERVICE_SECRET)) {
      return Response.json({ message: 'Not found' }, { status: 404 });
    }
    if (new URL(request.url).pathname === '/internal/deployment/ingestion') {
      return Response.json({ role: env.DEPLOYMENT_ROLE ?? 'ingestion', version: env.VERSION_METADATA ?? null });
    }
    return legacyWorker.fetch(request, env as Environment);
  },
  scheduled: legacyWorker.scheduled,
  queue: legacyWorker.queue,
};
