import { readFile, writeFile } from 'node:fs/promises';
import { companySizeKey, companySizeScore, companyWebsiteDomain } from '../src/company-size.js';

// Run after the offline streaming audit, never on a catalog request.
const input = process.argv[2];
if (!input) throw new Error('Usage: npx tsx scripts/import-company-size-snapshot.ts <audit.json>');
const report = JSON.parse(await readFile(input, 'utf8'));
const source = report.source;
if (source?.repository !== 'andreaaltomani/company-dataset' || source.license !== 'cc-by-4.0'
  || source.revision !== '0689a4c96cd3156b43d298860d5b6f29e82432bd'
  || report.summary?.dataset_sha256 !== '2d529f107b1b592d942c01dfbf696061fc33e646fcbfe92db547ae930706cfc2') {
  throw new Error('Unexpected dataset provenance; review the source before importing');
}
const seen = new Set<string>();
const records = report.companies.filter((row: { status: string; basis: string }) =>
  row.status === 'matched' && row.basis === 'domain-and-name').map((row: {
    company: string; domain: string; matched: { name: string; domain: string; size: string; id: string }; qa_reject?: string;
  }) => {
  const company = companySizeKey(row.company);
  const domain = companyWebsiteDomain(row.domain);
  const match = row.matched;
  const lowerBound = Number(match.size.split('-')[0].replace('+', ''));
  if (row.qa_reject || !company || seen.has(company) || !domain || domain !== companyWebsiteDomain(match.domain)
    || company !== companySizeKey(match.name) || !match.id || companySizeScore(lowerBound) === undefined
    || !['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+'].includes(match.size)) {
    throw new Error(`Invalid exact company match: ${row.company}`);
  }
  seen.add(company);
  return { company, domain, size: match.size, providerId: match.id };
}).sort((a: { company: string }, b: { company: string }) => a.company.localeCompare(b.company, 'en'));
if (!records.length) throw new Error('No exact name-and-domain matches');
const metadata = {
  source: `https://huggingface.co/datasets/${source.repository}`,
  revision: source.revision,
  sha256: report.summary.dataset_sha256,
  license: 'CC BY 4.0',
  attribution: 'Andrea Altomani company-dataset; original People Data Labs free company dataset',
  datasetUploadedAt: source.file.lastCommit.date,
  catalogSnapshotAt: report.summary.catalog_snapshot_at,
  selection: 'Unique exact normalized name and existing employer domain; size bands only. Other matches excluded.',
};
// One record per line keeps dataset updates reviewable.
const output = `{
  "metadata": ${JSON.stringify(metadata, null, 2).replace(/\n/g, '\n  ')},
  "records": [
${records.map((record: object) => `    ${JSON.stringify(record)}`).join(',\n')}
  ]
}\n`;
await writeFile('src/config/company-size-snapshot.json', output);
console.log(`Imported ${records.length} exact name-and-domain matches; unresolved employers retain the neutral fallback.`);
