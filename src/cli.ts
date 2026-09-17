#!/usr/bin/env node
import { defaultSources } from './sources/index.js';
import { Poller } from './poll.js';
import { DynamoInternshipStore, MemoryInternshipStore } from './store.js';
import { ExpoPushPublisher, sendDigest, SesEmailSender } from './notifications.js';
import { validateApplicationUrl } from './core/application-url.js';
import { admitGreenhouseSource, findReviewedGreenhouseSource } from './sources/greenhouse-config.js';
import { probeGreenhouseCandidate } from './sources/greenhouse.js';

const command = process.argv[2];
const table = process.env.INTERNSHIPS_TABLE;
const requiresTable = command === 'poll' || command === 'seed' || command === 'digest';
if (requiresTable && !table) throw new Error('INTERNSHIPS_TABLE is required');
const store = command === 'dry-run' ? new MemoryInternshipStore() : new DynamoInternshipStore(table ?? 'unused-for-smoke-tests');

async function main() {
  if (command === 'greenhouse:probe') {
    const token = process.argv[3];
    if (!token) throw new Error('Usage: greenhouse:probe <board-token-from-official-careers-page>');
    const result = await probeGreenhouseCandidate(token);
    console.log(JSON.stringify(result, null, 2));
    if (result.state === 'transport-error') process.exitCode = 2;
    else if (result.state !== 'ok') process.exitCode = 1;
    return;
  }
  if (command === 'greenhouse:admit') {
    const query = process.argv[3];
    if (!query) throw new Error('Usage: greenhouse:admit <source-id-or-alias>');
    const lookup = findReviewedGreenhouseSource(query);
    if (lookup.status === 'unknown') { console.error(`No reviewed Greenhouse source matches "${query}". Add it to the reviewed registry first.`); process.exitCode = 1; return; }
    if (lookup.status === 'ambiguous') { console.error(`"${query}" is ambiguous: ${lookup.candidates.map((candidate) => candidate.id).join(', ')}`); process.exitCode = 1; return; }
    const result = await admitGreenhouseSource(lookup.source);
    console.log(JSON.stringify(result, null, 2));
    if (result.inconclusive) {
      console.error('Admission was inconclusive (infrastructure failure). Re-run before admitting this board.');
      process.exitCode = 2;
    } else if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'poll' || command === 'seed' || command === 'dry-run') {
    const report = await new Poller(defaultSources, store, () => new Date(), undefined, validateApplicationUrl).poll({ seedOnly: command === 'seed' || command === 'dry-run' });
    console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
    return;
  }
  if (command === 'digest') {
    if (!process.env.SES_FROM || !process.env.SES_TO) throw new Error('SES_FROM and SES_TO are required');
    console.log(`Digested ${await sendDigest(store, new SesEmailSender(process.env.SES_FROM, process.env.SES_TO))} jobs`); return;
  }
  if (command === 'smoke-push') {
    if (!process.env.EXPO_PUSH_TOKEN) throw new Error('EXPO_PUSH_TOKEN is required');
    await new ExpoPushPublisher().publish(process.env.EXPO_PUSH_TOKEN, { title: 'Ntern', body: 'Push delivery is configured.', click: 'smoke-test' }); return;
  }
  if (command === 'smoke-email') {
    if (!process.env.SES_FROM || !process.env.SES_TO) throw new Error('SES_FROM and SES_TO are required');
    await new SesEmailSender(process.env.SES_FROM, process.env.SES_TO).send('Intern notifier smoke test', 'Email delivery is configured.', '<p>Email delivery is configured.</p>'); return;
  }
  throw new Error('Usage: poll | seed | dry-run | digest | smoke-push | smoke-email | greenhouse:probe | greenhouse:admit');
}
void main();
