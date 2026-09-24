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

## 2. Publish only changed catalog projection chunks to D1

### Current behavior

[`putCatalogProjection`](../cloudflare/d1-store.ts) hashes the complete grouped catalog. An unchanged refresh only updates the pointer, but any changed card writes **every** group under a new version and deletes the prior version. [`refreshCatalogProjection`](../cloudflare/worker.ts) publishes D1 first and R2 second. R2 is the primary read model; [`R2CatalogReadStore`](../cloudflare/r2-catalog-projection.ts) falls back to D1 when R2 is absent or fails. The D1 fallback serves unfiltered pages, filtered pages, role ranges, and individual groups. Keep that fallback complete and current.

### Implementation

1. Capture a representative projection baseline: group count, serialized bytes, groups changed per refresh, `rows_written` and `rows_read`, refresh duration, and D1 fallback latency for each read shape. Use an exported or synthesized local fixture for design testing; do not repeatedly scan production D1 for a benchmark.
2. Prototype a schema-versioned, content-addressed chunk format. Give chunks stable membership based on group identity, with byte bounds, so adding or removing one group does not shift every later chunk. Identify each chunk by its content digest. Store display order and group-to-chunk lookup in a small, bounded manifest or manifest pages. On refresh, write only new chunks, publish the new manifest after all chunks exist, then switch the current pointer. Refresh the pointer timestamp even when content is unchanged. Preserve the existing byte-bounded D1 batch behavior and verify D1 row and parameter limits with the largest observed group.
3. Implement all four D1 fallback reads against one captured manifest version per request. Keep page order, filters, role-range results, group lookup, and cursor behavior equivalent to the current schema. Bound chunk reads and Worker memory. If the new format moves too much filtering work into the Worker or increases D1 read charges enough to erase the write savings, revise the chunk size or stop the migration.
4. Retain the previous complete manifest and its chunks until no active reader can reference them. Garbage-collect unreferenced chunks in bounded batches after a grace period, so cleanup writes do not become a new cost spike. Handle overlapping refreshes and failed publication without deleting data referenced by a winning pointer.
5. Roll out reader compatibility before the new writer. Support the existing schema-version-4 pointer during migration and rollback. Keep the current D1-then-R2 publication order and the R2 invalidation behavior on publish failure, so a stale R2 snapshot cannot override a newer admission decision. Remove old-format rows only after read parity and rollback checks pass.

### Acceptance

- An unchanged refresh writes only its freshness pointer. A small catalog change writes only affected chunks, manifest data, and bounded cleanup; it does not rewrite every group. The prototype must demonstrate this for an inserted group as well as an edited group.
- Interrupted publication, concurrent refreshes, missing chunks, and rollback always leave a complete readable snapshot or a visible error. No partially published catalog is served.
- Local parity tests cover unfiltered and filtered pagination, role ranges, group lookup, changed sort order, removed groups, admission revocation, R2 failure, stale pointers, oversized payloads, and overlapping refreshes.
- On representative catalog data, total D1 rows written per changed refresh falls materially while fallback read rows, latency, and CPU stay within measured baseline budgets. Public catalog freshness remains within the existing ten-minute schedule.

## Sequence and rollout

1. Land the metadata optimization and its focused tests first. It has a smaller schema surface and should reduce repeated evidence and trigger writes independently of projection work.
2. Prototype and benchmark the chunked projection locally. Land compatible readers, then the writer, in separate reversible changes. Keep the old format available until parity is established.
3. For each production release, use the repository's guarded Cloudflare plan and deployment process, including `npx wrangler whoami`, build, OpenTofu plan/apply where infrastructure changes are needed, and read-only post-deploy verification. Do not force a protected audit through a busy queue.
4. Compare seven-day D1 Insights windows with similar ingestion volume after deployment. Watch rows written **and** rows read, billable usage, catalog age, projection errors, metadata coverage, review-token failures, queue depth, and D1 overloads. Roll back if freshness or correctness regresses even if write volume falls.

## Decision gate

Proceed with the projection migration only if the local prototype proves a net D1 cost reduction under the actual catalog size and filter traffic. If chunk manifests or fallback reads erase the savings, keep the current versioned D1 fallback and revisit the projection format with measured data.
