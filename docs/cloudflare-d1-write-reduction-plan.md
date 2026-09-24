# D1 write reduction plan

## Goal and scope

Reduce billed D1 rows written while preserving the current ten-minute catalog refresh, admission and revocation behavior, metadata collection coverage, and guarded repair checks. This plan covers two write paths: catalog projection publication and role metadata evidence recording. It does not change production configuration or deploy code.

Measure each change against a comparable production workload before claiming savings. D1 Insights query totals and `meta.rows_written` on representative operations are the primary measures; track rows read, Worker CPU, refresh duration, queue age, and catalog freshness alongside them. A cheaper write path is not a win if it makes the D1 fallback or ingestion unreliable.

## 1. Stop rewriting unchanged metadata evidence

### Current behavior

[`recordRoleMetadataEvidence`](../cloudflare/catalog-admission-store.ts) marks current evidence inactive for the replacement source classes, then upserts each extracted item, even when the artifact and extracted fields are unchanged. It also resolves and reopens conflict rows. Evidence updates fire global and per-job review-revision triggers. [`recordRoleMetadataExtraction`](../cloudflare/catalog-admission-store.ts) separately records the latest extraction attempt, which is already used with evidence timestamps by collection coverage and candidate scheduling.

### Implementation

1. Add a regression test that replays the same artifact and extracted fields with a later observation time. Record actual D1 row changes for evidence, conflicts, extraction attempts, and review revisions. Also test changed extraction version, changed evidence with the same artifact hash, multiple current items, empty replacement, and a newly resolved conflict.
2. Compare the incoming evidence set with the current set for the specified job, source, and replacement classes. Compare semantic content without `observedAt`, including nested provenance timestamps; compare extraction version, source URL, hash, and current status separately. Keep historical evidence. When the current set and conflict set are equal, skip evidence and conflict mutations entirely.
3. For a changed set, deactivate only current keys absent from the incoming set, insert or reactivate only new keys, and update existing keys only when their semantic content or extraction version changed. Apply the set transition atomically so readers never see a partly replaced set. Keep statement and payload bounds. The comparison must include all incoming hashes and URLs for a class; a single-hash exclusion would incorrectly retire other valid current items.
4. Keep re-observation freshness in the extraction-attempt row, which is already written by the verification flow. Update collection coverage and candidate selection to use the newest matching attempt for freshness, while using current evidence for field/outcome classification. A recent failed or fieldless attempt must not make stale evidence appear newly verified. Preserve the 24-hour retry rule for fieldless pages and the 30-day revalidation window.
5. Make conflict persistence differential: resolve only conflicts that left the incoming set; insert or reopen only new conflicts. Ensure review revisions still advance for any change that can alter an audit, repair token, or decision. An unchanged replay should not invalidate a staged review merely because an observation timestamp changed, unless the collection-coverage snapshot itself legitimately changes.

### Acceptance

- Same-artifact replay has **zero evidence-row and conflict-row changes**; freshness remains correct through the extraction attempt.
- New, removed, and changed evidence produce the same current evidence, projected metadata, conflicts, and guarded repair decisions as today.
- Replay and out-of-order queue tests preserve the newest observation and do not resurrect superseded evidence. A reviewed omission becomes invalid when its substantive evidence changes.
- A local D1 test reports before/after `rows_written` for the replay case, including trigger side effects. Production D1 Insights shows a sustained reduction for the evidence and `is_current` update query families without a rise in stale coverage or retry backlog.

## 2. Publish only changed catalog projection cards to D1

**Landed 2026-09-24.** Each card is already a self-contained chunk, so it is not
re-cut into buckets. D1 stores
each card under the group's own identity with a content-addressed suffix
(`GROUP#<groupId>#<digest>` in one `CATALOG_PROJECTION#GROUPS` partition), and the
display order became a key the card carries (`updatedAt`, with the group id breaking
ties) instead of a positional index. Inserting or removing a card therefore never
renumbers the others. A small manifest of active card keys is written before the
cards, then the schema-version-6 pointer is switched with a compare-and-swap.
Readers select only keys in that published manifest, so pending and retired rows
cannot appear in a page or group lookup. Old manifests and cards remain for two
minutes for in-flight readers; an unchanged tick retries interrupted cleanup.

Measured locally on 2026-09-24 with a 300-card fixture (~8.8 MB of cards, the
deployed projection carried 2,608 cards / 80.6 MiB):

| refresh | card batch statements | card batch payload | other rows written |
| --- | ---: | ---: | --- |
| full publish | 12 | 8,805,466 B | manifest and pointer |
| one card changed | 1 | 20,526 B | manifest and pointer |
| unchanged, no cleanup due | 0 | 0 B | pointer only |

The version this replaced wrote every card and deleted every card of the previous
version on any change — 2,608 writes and 2,608 deletes per changed tick at the
deployed size. The first refresh after the deploy still rewrites every card once,
because a version-4 copy is keyed by its version and cannot be reused.

### How the acceptance criteria are met

- **Unchanged refresh writes only the pointer when no cleanup is due** — the pointer
  carries the new `generatedAt` because readers cap a projection by its age.
- **A small change writes only the affected cards and a key manifest** — one
  changed card writes one card, plus the manifest and pointer. Superseded cards
  are deleted after the reader grace period in batches of 100. Covered for an
  edited card, an inserted card and a removed card in
  `test/d1-catalog-filter.test.ts` ("writes only the cards a refresh changed and
  orders them by the card itself").
- **All four reads keep their order and cursor semantics** — unfiltered pages,
  filtered pages, role ranges and group lookup select keys from the published
  manifest. The extra manifest existence check and SQL membership have a read
  cost that must be measured in dev and production. The parity tests also cover
  legacy version-4 rows, oversized payloads and byte budgets.
- **No partially published catalog** — D1 is still published before R2, R2 is still
  invalidated when its publish fails, and the pointer is switched after all cards
  are ready. Tests interrupt a card publish and a card cleanup, overlap two
  publishers, and remove a published manifest to check the visible outcomes.
- **Rollback needs a compatible reader** — schema-version-6 readers still accept
  version-4 pointers. A version-5 pointer is republished by the writer rather
  than served from its unscoped partition. An older reader does not understand a
  version-6 pointer; a rollback must republish a compatible projection before
  routing readers to older code, or roll forward with a repair.

One deliberate behaviour change: cards that share an `updatedAt` are now ordered by
group id rather than by the order they happened to be built in. Both read models use
that one order (the refresh sorts before it publishes to either), so the tie-break is
deterministic instead of incidental.

### Original acceptance (kept)

- An unchanged refresh writes only its freshness pointer. A small catalog change writes only affected chunks, manifest data, and bounded cleanup; it does not rewrite every group. The prototype must demonstrate this for an inserted group as well as an edited group.
- Interrupted publication, concurrent refreshes, missing chunks, and rollback always leave a complete readable snapshot or a visible error. No partially published catalog is served.
- Local parity tests cover unfiltered and filtered pagination, role ranges, group lookup, changed sort order, removed groups, admission revocation, R2 failure, stale pointers, oversized payloads, and overlapping refreshes.
- On representative catalog data, total D1 rows written per changed refresh falls materially while fallback read rows, latency, and CPU stay within measured baseline budgets. Public catalog freshness remains within the existing ten-minute schedule.

## Sequence and rollout

1. Land the metadata optimization and its focused tests first. It has a smaller schema surface and should reduce repeated evidence and trigger writes independently of projection work.
2. ~~Prototype and benchmark the chunked projection locally. Land compatible readers, then the writer, in separate reversible changes.~~ Landed 2026-09-24 with a schema-version-6 key manifest and compatible readers. Use the rollback sequence above after a version-6 publish; the benchmark is the local measurement above.
3. For each production release, use the repository's guarded Cloudflare plan and deployment process, including `npx wrangler whoami`, build, OpenTofu plan/apply where infrastructure changes are needed, and read-only post-deploy verification. Do not force a protected audit through a busy queue.
4. Compare seven-day D1 Insights windows with similar ingestion volume after deployment. Watch rows written **and** rows read, billable usage, catalog age, projection errors, metadata coverage, review-token failures, queue depth, and D1 overloads. Roll back if freshness or correctness regresses even if write volume falls.

## Decision gate

**Met locally 2026-09-24** for both sections: a one-card projection refresh writes
one card, one manifest and its pointer where it wrote 5,216 card rows at the
deployed size, and the metadata path
writes an observation row where it rewrote evidence, conflict and review rows. Both
measurements are local, so the remaining check is the production one below.

## Writes beyond the two sections

A survey of every D1 write path found the same redundancy outside these sections —
writers that re-store a row D1 bills whether or not its bytes changed. `catalog_items`
job, occurrence, checkpoint, health, dispatch and monitoring upserts now compare the
stored row with the value they would store (including the derived index columns, so a
changed derivation still repairs the row); the acquisition report, shadow handoff,
verification evidence, incident and incident-notification writers compare too. The
`catalog_items` upserts also carry the two review triggers, so skipping an identical
write saves three billed rows, not one. `test/d1-write-reduction.test.ts` replays each
writer and counts the rows D1 would bill.
