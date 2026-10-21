import snapshot from './config/company-size-snapshot.json' with { type: 'json' };
import { companySizeKey, companySizeScore } from './company-size.js';

// Offline public dataset subset. No enrichment, credentials or network on reads.
// Attribution, source revision and per-company evidence ship with the snapshot.
const scores = new Map(snapshot.records.map(record => [record.company,
  companySizeScore(Number(record.size.split('-')[0]!.replace('+', '')))]));

export const snapshotCompanySizeScore = (company: string): number | undefined => scores.get(companySizeKey(company));
