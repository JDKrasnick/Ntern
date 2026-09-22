import legacyWorker, { type Environment } from './worker.js';
import { isIngestionOperationPath, secretMatches, type ServiceBinding } from './split.js';
export { ResumePdfCompiler } from './resume-pdf-container.js';

export interface ApiEnvironment extends Partial<Environment> {
  INGESTION: ServiceBinding;
  INTERNAL_SERVICE_SECRET: string;
  OPERATIONS_SHARED_SECRET: string;
  DEPLOYMENT_ROLE?: string;
  VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
}

function authorized(request: Request, env: ApiEnvironment): boolean {
  return secretMatches(request.headers.get('X-Operations-Key'), env.OPERATIONS_SHARED_SECRET);
}

async function forwardToIngestion(request: Request, env: ApiEnvironment): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set('X-InternNotifs-Service-Key', env.INTERNAL_SERVICE_SECRET);
  return env.INGESTION.fetch(new Request(request, { headers }));
}

export default {
  async fetch(request: Request, env: ApiEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/internal/deployment') {
      if (!authorized(request, env)) return Response.json({ message: 'Not found' }, { status: 404 });
      try {
        const response = await forwardToIngestion(new Request(new URL('/internal/deployment/ingestion', request.url)), env);
        if (!response.ok) return Response.json({ message: 'Ingestion deployment identity is unavailable' }, { status: 502 });
        return Response.json({
          api: { role: env.DEPLOYMENT_ROLE ?? 'api', version: env.VERSION_METADATA ?? null },
          ingestion: await response.json(),
        });
      } catch {
        return Response.json({ message: 'Ingestion deployment identity is unavailable' }, { status: 502 });
      }
    }
    if (isIngestionOperationPath(url.pathname)) return forwardToIngestion(request, env);
    // Public routes never enter the ingestion branches in the shared handler.
    // Config tests keep this narrow API binding set synchronized with that boundary.
    return legacyWorker.fetch(request, env as Environment);
  },
};
