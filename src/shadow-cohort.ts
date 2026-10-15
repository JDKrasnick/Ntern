import { createHash } from 'node:crypto';

type Identity = { sourceId: string; externalId: string; contentHash: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const leaf = (entry: Identity) => hash(['shadow-publication-cohort-v1', entry.sourceId, entry.externalId, entry.contentHash]);
const parent = (left: string, right: string) => hash([left, right].sort());

/** A compact root fits the Worker variable; each exact revision carries its proof. */
export function buildShadowCohort(entries: readonly Identity[]) {
  if (!entries.length || entries.length > 250 || new Set(entries.map(leaf)).size !== entries.length) throw new Error('Invalid historical cohort');
  const levels = [entries.map(leaf)];
  while (levels.at(-1)!.length > 1) {
    const prior = levels.at(-1)!;
    levels.push(Array.from({ length: Math.ceil(prior.length / 2) }, (_, i) => parent(prior[i * 2]!, prior[i * 2 + 1] ?? prior[i * 2]!)));
  }
  return { root: levels.at(-1)![0]!, size: entries.length, entries: entries.map((entry, index) => {
    const proof: string[] = [];
    for (const level of levels.slice(0, -1)) { proof.push(level[index ^ 1] ?? level[index]!); index = Math.floor(index / 2); }
    return { ...entry, proof };
  }) };
}

export function verifyShadowCohortProof(root: string, entry: Identity, proof: unknown): boolean {
  if (!Array.isArray(proof) || proof.length > 8 || proof.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))) return false;
  return proof.reduce((current: string, sibling: string) => parent(current, sibling), leaf(entry)) === root;
}
