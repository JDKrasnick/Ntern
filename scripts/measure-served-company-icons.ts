/** All-catalog coverage measured from actual public image responses, including
 * roles without canonical employer IDs. No database or icon decisions are written.
 * Usage: tsx scripts/measure-served-company-icons.ts [--base-url https://api.ntern.app] [--report path.json]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { companyIconIdentity } from '../shared/company-icon.js';

const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const base = option('--base-url') ?? 'https://api.ntern.app';
const sql = `SELECT json_extract(item.value, '$.group.featuredRole') AS role,
    json_extract(item.value, '$.group.roleCount') AS roles
  FROM catalog_items AS item
  JOIN catalog_items AS current ON current.pk = 'CATALOG_PROJECTION' AND current.sk = 'CURRENT'
  JOIN catalog_items AS manifest ON manifest.pk = 'CATALOG_PROJECTION#MANIFESTS'
    AND manifest.sk = json_extract(current.value, '$.version')
  WHERE item.pk = 'CATALOG_PROJECTION#GROUPS'
    AND EXISTS (SELECT 1 FROM json_each(manifest.value, '$.keys') WHERE value = item.sk)`;
const pages = JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'intern-notifs-db',
  '--config', 'wrangler.api.jsonc', '--remote', '--json', '--command', sql],
{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as Array<{ results: Array<{ role: string; roles: number }> }>;
const keys = new Map<string, number>();
let totalRoles = 0;
for (const row of pages.flatMap((page) => page.results)) {
  const role = JSON.parse(row.role);
  totalRoles += row.roles;
  const key = role.canonicalEmployerId ?? role.companyIconId ?? companyIconIdentity(role.company, role.officialApplyUrl)?.id;
  if (key) keys.set(key, (keys.get(key) ?? 0) + row.roles);
}
const queue = [...keys];
const results: Array<{ id: string; roles: number; status: number; type?: string; bytes?: number }> = [];
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < queue.length) {
    const [id, roles] = queue[next++]!;
    try {
      const response = await fetch(`${base.replace(/\/$/u, '')}/company-icons/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(20_000) });
      const bytes = (await response.arrayBuffer()).byteLength;
      results.push({ id, roles, status: response.status, type: response.headers.get('content-type') ?? '', bytes });
    } catch { results.push({ id, roles, status: 0 }); }
  }
}));
const served = results.filter((row) => row.status === 200 && /^image\/(?:png|webp|avif)(?:;|$)/u.test(row.type ?? '') && (row.bytes ?? 0) > 0);
const coveredRoles = served.reduce((total, row) => total + row.roles, 0);
const report = { measuredAt: new Date().toISOString(), base, totalRoles, coveredRoles,
  coveragePercent: 100 * coveredRoles / totalRoles,
  servedKeys: served.length, attemptedKeys: keys.size, errors: results.filter((row) => row.status === 0).length, results };
if (option('--report')) writeFileSync(option('--report')!, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
