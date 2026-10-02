/**
 * Production watch for the read-time live catalog overlay.
 *
 * The grouped catalog is rebuilt on a ten-minute cron, but a role is
 * alerts-eligible and `catalog_state = 'OPEN'` the moment its source occurrence
 * is published. The overlay closes that window: the projection pointer records
 * the highest open-role sort key its publish observed (`liveWatermark`), and any
 * open role newer than it is grouped on the read path.
 *
 * This watch proves that guarantee end-to-end against production:
 *
 *   1. Read the served projection pointer and require a `liveWatermark`. Its
 *      absence means the ingestion Worker has not published with the overlay
 *      yet, which is exactly the condition the watch is waiting for.
 *   2. Read the newest publishable open role newer than the watermark.
 *   3. Require that role's card to lead the public `/catalog` feed. A later
 *      rebuild would also contain the role, so step 2 deliberately selects a
 *      role the last tick could not have projected.
 *
 * When production has no unprojected role at sample time the run passes without
 * asserting the overlay (there is no gap to observe), and retries briefly first.
 *
 * Read-only: Cloudflare's D1 query API and the public catalog, nothing else.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run catalog:overlay:watch
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { catalogPublishable } from '../src/catalog-live.js';
import { openCatalogSortKey } from '../src/catalog-recency.js';
import type { Internship } from '../src/types.js';

const PRODUCTION_D1_DATABASE_ID = '4e389f1c-7c6d-48e1-aa97-dc4cb1769bb8';
const DEFAULT_PUBLIC_API_URL = 'https://intern-notifs.jdkrasnick.workers.dev';
const MAX_DELTA_ROLES = 200;
const SAMPLE_ATTEMPTS = 6;
const SAMPLE_DELAY_MS = 30_000;

interface D1Pointer {
  version?: string;
  generatedAt?: string;
  schemaVersion?: number;
  liveWatermark?: string;
}

/** Newest publishable open role newer than the watermark, or undefined when the projection is current. */
export function newestPublishableUnprojected(rows: Array<{ value: string }>, watermark: string): Internship | undefined {
  const jobs = rows
    .map((row) => JSON.parse(row.value) as Internship)
    .filter((job) => job.open && catalogPublishable(job) && openCatalogSortKey(job) > watermark);
  return jobs.reduce<Internship | undefined>((newest, job) =>
    !newest || openCatalogSortKey(job) > openCatalogSortKey(newest) ? job : newest, undefined);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<number> {
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID ?? PRODUCTION_D1_DATABASE_ID;
  const publicApiUrl = (process.env.PUBLIC_API_URL ?? DEFAULT_PUBLIC_API_URL).replace(/\/+$/u, '');

  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
    const body = (await response.json()) as {
      success: boolean; errors?: Array<{ message?: string }>; result?: Array<{ results: T[] }>;
    };
    if (!response.ok || !body.success) {
      throw new Error(`D1 query failed: ${body.errors?.map((error) => error.message).join('; ') ?? response.status}`);
    }
    return body.result?.[0]?.results ?? [];
  };

  const lines: string[] = ['Catalog live overlay watch', ''];
  const finish = (code: number): number => {
    const summary = lines.join('\n');
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`); } catch { /* best effort */ }
    }
    return code;
  };

  const pointerRows = await query<{ value: string }>(
    "SELECT value FROM catalog_items WHERE pk = 'CATALOG_PROJECTION' AND sk = 'CURRENT'",
  );
  if (!pointerRows.length) {
    lines.push('The projection pointer is missing. Production has not published a projection under this database yet.');
    return finish(1);
  }
  const pointer = JSON.parse(pointerRows[0]!.value) as D1Pointer;
  lines.push(`Pointer version \`${pointer.version ?? 'unknown'}\`, generated \`${pointer.generatedAt ?? 'unknown'}\`.`);
  if (!pointer.liveWatermark) {
    lines.push('No `liveWatermark` on the pointer: the ingestion Worker has not published with the overlay yet.');
    lines.push('Re-run this watch after the ingestion Worker is patched; the absence is the condition being waited on.');
    return finish(1);
  }
  lines.push(`Watermark \`${pointer.liveWatermark}\`.`);

  let target: Internship | undefined;
  let sampledRows = 0;
  for (let attempt = 0; attempt < SAMPLE_ATTEMPTS && !target; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, SAMPLE_DELAY_MS));
    const rows = await query<{ value: string }>(
      "SELECT value FROM catalog_items WHERE catalog_state = 'OPEN' AND catalog_sort_key > ? ORDER BY catalog_sort_key DESC LIMIT ?",
      [pointer.liveWatermark, MAX_DELTA_ROLES + 1],
    );
    sampledRows = rows.length;
    target = newestPublishableUnprojected(rows, pointer.liveWatermark);
  }

  if (!target) {
    lines.push('No publishable open role newer than the watermark at sample time.');
    lines.push('The projection is current, so there is no unprojected role to assert; nothing to check this run.');
    return finish(0);
  }

  const jobId = target.jobId;
  lines.push(`Newest unprojected publishable role: \`${jobId}\` (${target.company} — ${target.title}).`);
  if (sampledRows > MAX_DELTA_ROLES) {
    lines.push(`Note: the delta holds more than ${MAX_DELTA_ROLES} open roles, so a read serves the snapshot by design.`);
  }

  const response = await fetch(`${publicApiUrl}/catalog?limit=50`);
  if (!response.ok) {
    lines.push(`Public catalog returned ${response.status}.`);
    return finish(1);
  }
  const body = (await response.json()) as { groups?: Array<{ groupId: string; company: string; roleIds: string[] }> };
  const groups = body.groups ?? [];
  const leading = groups[0];
  if (leading?.roleIds.includes(jobId)) {
    lines.push('PASS: the unprojected role leads the served catalog.');
    lines.push(`First card \`${leading.groupId}\` (${leading.company}) contains \`${jobId}\`.`);
    return finish(0);
  }

  const containing = groups.find((group) => group.roleIds.includes(jobId));
  lines.push(containing
    ? `FAIL: \`${jobId}\` is served but not as the leading card (${containing.groupId}); the live prefix is not leading the feed.`
    : `FAIL: \`${jobId}\` is not served by the public catalog at all.`);
  lines.push('The overlay is not closing the projection window; inspect `catalog_live_overlay_failed` logs and the delta bound.');
  return finish(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
