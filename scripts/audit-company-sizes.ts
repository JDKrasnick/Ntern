import { readFile, writeFile } from 'node:fs/promises';
import { companyRating, companyTierScore } from '../src/company-ratings.js';
import { companySizeKey } from '../src/company-size.js';
import { scoreOpportunity } from '../src/opportunity-score.js';
import type { CatalogGroupRow } from '../src/catalog-groups.js';

const args = process.argv.slice(2);
const argument = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const output = argument('--output') ?? '.context/company-size-audit.json';
const snapshotPath = argument('--snapshot');
const groups: CatalogGroupRow[] = [];
const snapshotAt = new Date().toISOString();
const api = argument('--api-url') ?? 'https://api.ntern.app';
if (snapshotPath) {
  groups.push(...JSON.parse(await readFile(snapshotPath, 'utf8')) as CatalogGroupRow[]);
} else {
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const url = new URL('/catalog', api);
    url.search = new URLSearchParams({ sort: 'newest', status: 'open', limit: '50', addedBefore: snapshotAt,
      ...(cursor ? { cursor } : {}) }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Catalog returned HTTP ${response.status}`);
    const page = await response.json() as { groups: CatalogGroupRow[]; cursor?: string };
    if (!Array.isArray(page.groups)) throw new Error('Catalog page is missing groups');
    groups.push(...page.groups);
    cursor = page.cursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error('Catalog cursor repeated');
      cursors.add(cursor);
    }
    if (groups.length > 20_000) throw new Error('Catalog audit exceeded 20,000 groups');
  } while (cursor);
  await writeFile(`${output}.snapshot.json`, JSON.stringify(groups));
}

const ids = new Set<string>(), roleIds = new Set<string>();
const companies = new Map<string, { company: string; groups: number; roles: number; reviewed: boolean; lookup: boolean }>();
let testedScores = 0;
for (const group of groups) {
  if (ids.has(group.groupId)) throw new Error(`Duplicate catalog group ${group.groupId}`);
  ids.add(group.groupId);
  const key = companySizeKey(group.company);
  if (!key || !group.featuredRole || !group.roleIds?.length) throw new Error(`Incomplete catalog group ${group.groupId}`);
  for (const id of group.roleIds) {
    if (roleIds.has(id)) throw new Error(`Duplicate catalog role ${id}`);
    roleIds.add(id);
  }
  const company = companies.get(key) ?? { company: group.company, groups: 0, roles: 0, reviewed: Boolean(companyRating(group.company)), lookup: companyTierScore(group.company) !== undefined };
  company.groups++;
  company.roles += group.roleIds.length;
  companies.set(key, company);
  const original = scoreOpportunity(group.featuredRole);
  // Every actual catalog representative exercises missing, small, medium and
  // large fallback values. These are scenarios, not live provider evidence.
  for (const size of [undefined, 50, 55, 65, 75, 85]) {
    const score = scoreOpportunity(group.featuredRole, size === undefined ? undefined : new Map([[companySizeKey(group.featuredRole.company), size]]));
    if (![score.company, score.pay, score.role, score.total].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) throw new Error(`Invalid score for ${group.groupId}`);
    if ((companyRating(group.featuredRole.company) || companyTierScore(group.featuredRole.company) !== undefined) && score.company !== original.company) throw new Error('Size lookup overrides a known company');
    if (score.pay !== original.pay || score.role !== original.role) throw new Error('Size lookup changes another ranking component');
    testedScores++;
  }
}
const rows = [...companies.values()];
const report = { snapshotAt, source: snapshotPath ?? api, groups: groups.length, roles: roleIds.size,
  companies: rows.length, reviewedCompanies: rows.filter(row => row.reviewed).length,
  unreviewedCompanies: rows.filter(row => !row.reviewed).length,
  reviewedRoles: rows.filter(row => row.reviewed).reduce((sum, row) => sum + row.roles, 0),
  knownCompanies: rows.filter(row => row.reviewed || row.lookup).length,
  knownRoles: rows.filter(row => row.reviewed || row.lookup).reduce((sum, row) => sum + row.roles, 0),
  liveProviderLookups: 0, syntheticScoreScenariosPassed: testedScores, uniqueGroupsAndRoles: true,
  companyCoverage: rows.sort((a, b) => b.roles - a.roles) };
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, companyCoverage: undefined, output }, null, 2));
