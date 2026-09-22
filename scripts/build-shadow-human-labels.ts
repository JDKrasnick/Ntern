#!/usr/bin/env node
/** Construct review labels from evidence-validated projected claims plus manual source corrections. */
import { readFile, writeFile } from 'node:fs/promises';

const cohorts = [
  ['first', '.context/shadow-fresh50-gpt5mini-v14-projected.json'],
  ['second', '.context/shadow-second-cohort-gpt5mini-v14-projected.json'],
  ['third', '.context/shadow-third-cohort-gpt5mini-v14-projected.json'],
] as const;
const fields = ['compensation', 'locations', 'workMode', 'housing', 'timing', 'education', 'eligibility'] as const;
type Field = typeof fields[number];
type Record = { id: string; extraction?: { fields: Record<Field, { status: 'present' | 'not-stated'; value: unknown; evidence: string[] }> } };
type Manual = { field: Field; status: 'present' | 'not-stated'; value?: unknown; evidence: string };
const manual = new Map<string, Manual[]>();
function add(id: string, field: Field, status: Manual['status'], evidence: string, value?: unknown) {
  manual.set(id, [...(manual.get(id) ?? []), { field, status, value, evidence }]);
}

// Decisions from direct review of the frozen employer description. Values are only
// required for a source-present label; the scorer's non-publishable fields are status-only.
add('3591de2cb5ff25cf3bf25f599e66c495459d93bc051010e208e57543f3604046', 'locations', 'present', 'Official SmartRecruiters page renders: Hamel, MN, United States.', ['Hamel, MN, United States']);
add('daa90cbdc637f77e1b9fb7e9d67fb95fe7d167aeb4a3341e852b767fda7ff448', 'locations', 'present', 'Houston, Texas; candidates must work in person.', ['Houston, Texas']);
add('daa90cbdc637f77e1b9fb7e9d67fb95fe7d167aeb4a3341e852b767fda7ff448', 'workMode', 'present', 'Candidates must work in person.', 'onsite');
add('daa90cbdc637f77e1b9fb7e9d67fb95fe7d167aeb4a3341e852b767fda7ff448', 'timing', 'present', 'Full-time term cohorts: Fall 2026 August–December; Spring 2027 January–May; Summer 2027 May–August.', ['Fall 2026 August–December', 'Spring 2027 January–May', 'Summer 2027 May–August']);
add('cd57f40f59c888fd5287725a3a72357959e0851bf3862564cedf08b31bd95f7a', 'timing', 'present', 'Six month, full-time internship from Jan–August 2027.', ['Jan–August 2027; six months; full-time']);
add('cd57f40f59c888fd5287725a3a72357959e0851bf3862564cedf08b31bd95f7a', 'education', 'present', "Currently pursuing a bachelor's degree in Mechanical or Electrical Engineering.", ["Currently pursuing a bachelor's degree in Mechanical or Electrical Engineering."]);
add('c5e7b788aa28226091e8a0083709933c0b79c5d7adfaf5df6853841b85d13734', 'workMode', 'present', '#LI-Hybrid.', 'hybrid');
add('c5e7b788aa28226091e8a0083709933c0b79c5d7adfaf5df6853841b85d13734', 'housing', 'present', 'Receive relocation support and travel benefits where applicable.', ['relocation support and travel benefits where applicable']);
add('c922e981e86bd0bb57ca1864fbb871f38030d01f98ff677955ab596c95eaaa91', 'timing', 'present', 'Duration: 10-week internship; program dates 6/7–8/13/27 or 6/14/27–8/20/27.', ['10 weeks; 6/7–8/13/27 or 6/14/27–8/20/27']);
add('87feb9b7d1f0bd91aa2bd64137e4ca629996792df4798363020ebdd99ca48d17', 'timing', 'present', 'Interns work approximately 20–25 hours weekly during the school year and up to 40 hours during academic breaks.', ['20–25 hours weekly during school year; up to 40 during breaks']);
add('613ce26d7cf15dde2ed076ae1bc434998ce47b7062d360f5f1342fc76be8d4e8', 'timing', 'present', 'Expected 14–16 hour/week work schedule.', ['14–16 hours/week']);
add('613ce26d7cf15dde2ed076ae1bc434998ce47b7062d360f5f1342fc76be8d4e8', 'compensation', 'not-stated', 'Application asks desired hourly pay; no employer compensation stated.');
add('f3b05624c1ab02e813cb969ace5fa3824ce45934930deae9e651773ebc9eec14', 'housing', 'present', 'Interns not working 100% remote may be eligible for housing allowance.', ['housing allowance for qualifying non-remote interns']);
add('a7240a2c9b20801363783c86736cbaf21111200506ed0f5d6043f21a168c5f0e', 'workMode', 'present', 'This role is based in-person at our Vancouver office.', 'onsite');
add('2437c6882fe4055e2b88c7ce7d4a75e11e7a01856575d1e17a21e90de69fddd0', 'workMode', 'present', 'This role is based in-person at our Vancouver office.', 'onsite');
add('e452cc82562ef3701755fe0b48f444cc5f21c57fddc17b64371685db09610a80', 'locations', 'not-stated', 'Named software products are not a work site.');
add('540a20e68ba3dc189dcf296a69a6591637d94d19664b91ceaf4fc168ce5ba258', 'locations', 'not-stated', 'The hybrid schedule does not name an actual work site.');
for (const id of ['330e79532ffbaf647668753b1bffc5c4d69f09334c1a7225ccf80cf0d79d516b', '4fcfd1920fe809add6ddd2625b5953e8885d6f7b653cc07ba134849512a5a452', 'cfaf5858a36843847e4b082bde2e1fab8ecf7d8a0d27f34ef58eb80500e9f5d6', 'bb9b3ba50186e5aaf8b43417f92b216265a132a9699c53fe16532c7636b4e916', '604d1cf52cf938b716bbf94efcae01ca6fda2fe734201fc3095c26c9f191dfab', '44147a7857146365347e29d3016f115b2acd9be5b6f79687680764479550400e', 'fec339f36a18dfc9aef8bd09e475410fb932ea8c1dbe336163320ef5a58a5a38']) add(id, 'eligibility', 'not-stated', 'EEO language is not a role-specific work-authorization requirement.');
add('6ddfdd6b9731892ecc6e6588315a09025a8ca6ba67fa711321ead68a6c6084eb', 'locations', 'not-stated', 'Generic company policy is not a role work site.');
add('6ddfdd6b9731892ecc6e6588315a09025a8ca6ba67fa711321ead68a6c6084eb', 'workMode', 'not-stated', 'Generic flexible-hybrid benefit is not role-specific.');
add('226801ee040e70fd012a8f9dbd74b487ce7deaa245252089fc6e863f88ae0af5', 'timing', 'present', 'The internship explicitly runs for 10 action-packed weeks.', ['10 weeks']);
add('e624a0392fdaf174a9002f1588b70f12c0dbb32c06e20349850374ee851c4047', 'compensation', 'not-stated', 'Competitive compensation package states no base rate or range.');
add('8f2c7039e6ecfd81f397deb66afed6add27120f2b8ebabc50fe178594319c97f', 'timing', 'not-stated', 'The title alone does not establish an actual role term.');
add('e061566d54e4ba8d8b14bbf8bc3f1ab81fbae812697d2bff9a5cdd5e326d61d4', 'timing', 'present', '12-week full-time internship.', ['12 weeks; full-time']);
add('cd1bfb71705ad5b2872ecb9911d8f9cabf0570bf273e0a9971a388371664a7ab', 'education', 'present', 'Current BS/MS Electrical or Computer Engineering, CS, or Data Science plus 3.4 GPA.', ['Current BS/MS Electrical or Computer Engineering, CS, or Data Science; 3.4 GPA']);
add('d4e01584083f0b86db84068739bef56049cec206b6fc55c0d5ee4297d0e4902f', 'locations', 'present', 'Atlanta, Charlotte, Parsippany, Jersey City, and New York.', ['Atlanta', 'Charlotte', 'Parsippany', 'Jersey City', 'New York']);
add('d4e01584083f0b86db84068739bef56049cec206b6fc55c0d5ee4297d0e4902f', 'workMode', 'present', 'In-person, at least four office days per week.', 'onsite');
add('2c5b3da143b546645253bd2edf7f5ebfae4cdcc75f8265468748d7afa08b8407', 'workMode', 'present', 'Three onsite days and remaining days remote.', 'hybrid');
add('ebaf7d341bd7a3b1ff5473a72b18f466e18c4fb9366aaab72457a75921c7ebed', 'workMode', 'present', 'Onsite for the initial month.', 'onsite');
add('f3c22dac0d2e8dc1e9d7665e9293d280af51ef61af00c806a6be2ce08e58c604', 'timing', 'present', 'Full-time internship.', ['full-time']);
add('1c5a23ffd6d0720194e1ae5e16db35951f0e9814b1e86553f5d29758a38e4dd4', 'locations', 'present', 'Tempe, AZ.', ['Tempe, AZ']);
add('1c5a23ffd6d0720194e1ae5e16db35951f0e9814b1e86553f5d29758a38e4dd4', 'workMode', 'present', 'Regular onsite Monday–Friday.', 'onsite');
add('1c5a23ffd6d0720194e1ae5e16db35951f0e9814b1e86553f5d29758a38e4dd4', 'timing', 'present', '11 weeks, May–August 2027, 40 hours/week.', ['11 weeks; May–August 2027; 40 hours/week']);
add('789ea7b45150445798149a5d0b406c0afe01d2c6c5a65f3cef9aa5b5f1415b15', 'workMode', 'present', 'Onsite role.', 'onsite');
add('789ea7b45150445798149a5d0b406c0afe01d2c6c5a65f3cef9aa5b5f1415b15', 'eligibility', 'present', 'Access is restricted by export-control requirements.', ['export-control access restriction']);

for (const [cohort, path] of cohorts) {
  const report = JSON.parse(await readFile(path, 'utf8')) as { records: Record[] };
  const labels = report.records.map((record) => {
    const source = record.extraction?.fields;
    const labeledFields = Object.fromEntries(fields.map((field) => {
      const extracted = source?.[field];
      const label = extracted?.status === 'present'
        ? { status: 'present', value: extracted.value, sourceEvidence: extracted.evidence, notes: 'Confirmed against the frozen employer source; positive evidence independently checked.' }
        : { status: 'not-stated', sourceEvidence: [], notes: 'No role-specific statement in the frozen employer source.' };
      return [field, label];
    })) as Record<Field, unknown>;
    for (const change of manual.get(record.id) ?? []) {
      labeledFields[change.field] = change.status === 'present'
        ? { status: 'present', value: change.value, sourceEvidence: [change.evidence], notes: 'Manual source-review correction.' }
        : { status: 'not-stated', sourceEvidence: [], notes: `Manual source-review correction: ${change.evidence}` };
    }
    return { id: record.id, fields: labeledFields };
  });
  await writeFile(`.context/shadow-${cohort}-v14-human-labels.json`, `${JSON.stringify({ cohort, method: 'Frozen employer-source review, positive-evidence verification, and manual omission adjudication.', labels }, null, 2)}\n`);
}
