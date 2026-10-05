import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const approvedOrigins = new Set([
  'https://intern-notifs.jdkrasnick.workers.dev',
  'https://intern-notifs-dev.jdkrasnick.workers.dev',
]);

/** Probe the API selected by the verified web artifact before replacing Pages. */
export async function verifyPublicWebApi(manifest: unknown, request = fetch): Promise<void> {
  const apiOrigin = manifest && typeof manifest === 'object' && 'apiOrigin' in manifest ? manifest.apiOrigin : undefined;
  if (typeof apiOrigin !== 'string' || !approvedOrigins.has(apiOrigin)) throw new Error('Unapproved artifact API origin');
  const response = await request(`${apiOrigin}/jobs?status=open&scan=bounded&limit=1`, {
    headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new Error('Artifact API is unavailable');
  }
  const result = await response.json() as { scanBudget?: number; jobs?: unknown[] } | null;
  if (!result || result.scanBudget !== 100 || !Array.isArray(result.jobs) || result.jobs.length > 1) {
    throw new Error('Artifact API has not deployed bounded public reads');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: verify-public-web-api.ts <artifact-manifest>');
  await verifyPublicWebApi(JSON.parse(await readFile(path, 'utf8')));
  console.log('Verified bounded reads on the web artifact API');
}
