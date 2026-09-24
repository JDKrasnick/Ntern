import { Container } from '@cloudflare/containers';

/**
 * Dedicated, no-network TeX process. The Worker passes only escaped output
 * from fixed templates; this class never accepts user-selected commands.
 */
export class ResumePdfCompilerV2 extends Container {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = '2m';
  enableInternet = false;
  pingEndpoint = '/health';

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/compile') return new Response('Not found', { status: 404 });
    if ((request.headers.get('content-type') ?? '').split(';')[0] !== 'application/x-tex') return new Response('Unsupported content type', { status: 415 });
    if (Number(request.headers.get('content-length') ?? 0) > 256_000) return new Response('Source exceeds compiler limit', { status: 413 });
    return this.containerFetch(request);
  }
}
