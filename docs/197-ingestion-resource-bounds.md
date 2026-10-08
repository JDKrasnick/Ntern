# #197 ingestion queue resource bounds

Status: the two mechanisms behind the `exceededCpu` / `exceededMemory`
invocations are identified and fixed, with production-scale regression coverage.
The bounds are deployed and the stranded dead-letter messages are replayed by the
guarded operations path; the post-deploy observations are recorded at the end of
this document.

## 2026-09-28 retained-history follow-up

The original bound limited resolution work but still hydrated the complete source
occurrence partition. Production growth exposed that remaining memory dependency:
`simplify-summer-2026` now retains 5,337 occurrence rows / 39,529,479 JSON bytes,
including 1,970 inactive rows, and its durable checkpoint is 612,516 bytes with
2,069 pending resolution rows. `speedyapply-2027-swe` retains another 1,937 rows /
14,214,719 bytes. Those rows are valid catalog history and are not discarded.

A bounded GitHub delivery now uses the existing durable checkpoint as its cursor
and hydrates complete occurrence JSON only for the selected slice. The final slice
adds only compactly identified lifecycle-actionable omissions; settled closed
history is neither loaded nor rewritten. Compact D1 projections separately find
retired trusted-community admission and changed trusted-source material. New or
reappeared board rows move ahead of the older retry order, while omission counts
advance only after the complete board pass, so the memory bound preserves both
new-role discovery and closure coverage. A frozen R2 board snapshot is unnecessary:
refetching the current board for each durable slice is what lets newly published
roles enter an already-open pass.

## Determination

Two independent defects, one per lane:

1. **GitHub `exceededCpu` (32,500 ms in production).** `htmlTables` computed each
   HTML-table row number with `markdown.slice(0, start).split('\n').length`, so a
   board with R rows over N bytes cost O(R × N). `simplify-summer-2026` fetches two
   documents (1,081,546 B / 1,785 rows and 1,648,342 B / 4,716 rows). The row
   expression alone accounted for ~9.5 s of the 9.8 s `SourceFetchDurationMs`, and
   a full `IngestionRunner.poll` for that source measured **12.0 s CPU / 10.8 s
   wall** with an in-memory store.
2. **`exceededMemory` on both lanes.** A message retained more than an isolate
   holds: the parsed board plus a second, fully serialized projection of it
   (GitHub additionally retained 4,194 occurrence rows / 24.9 MB and read them
   twice per delivery). `greenhouse-spacex` (27.8 MB board) OOMed at
   `--max-old-space-size=112` with 105-106 MB live heap immediately after
   `JSON.parse`; `greenhouse-andurilindustries` (40.7 MB board) reached **149 MB
   live heap after `JSON.parse` alone**. Peak was ≈3.7× the body bytes, while the
   existing guards (`GREENHOUSE_RESPONSE_MAX_BYTES = 64 MB`,
   `GREENHOUSE_BOARD_MAX_JOBS = 5_000`) sat far above what fits.

A resource kill writes no health row and bypasses the failure ledger, so the
source looked `healthy`/`active`, never backed off, and never quarantined.

## Reproduced measurements (this workstation, 2026-09-15/16)

"Before" figures were captured during the #197 investigation against the same
inputs; "after" figures were re-measured after the fixes. The before/after pair
for each row was taken the same way.

| Measurement | Before | After |
| --- | --- | --- |
| `parseInternshipMarkdown` on `README-Off-Season.md` (1,648,342 B, 1,244 listings) | 7,180 ms CPU | 105 ms CPU |
| Row numbers vs the previous slice expression on that document | — | 0 mismatches; identical listings |
| Largest GitHub source (3,029 listings, 4,194 occurrences / 24.9 MB) per delivery | 12.0 s CPU (whole board, one message) | 2.6-3.6 s CPU per delivery (16 sliced deliveries at 200 rows) |
| Peak heap for that delivery (after `gc()`, incl. the 2.7 MB synthetic documents) | OOM at 128 MB; needs ≥192 MB | 30-79 MB of delivery-attributable growth, ≤106 MB absolute in the harness |
| Listings resolved per delivery | 3,029 | ≤200 (`GITHUB_RESOLUTION_ROWS_PER_DELIVERY`) |
| `greenhouse-spacex` shape (27,849,116 B) | 105-106 MB live after `JSON.parse`, OOM at 112 MB | rejected as `capacity` before `JSON.parse` |
| `greenhouse-andurilindustries` shape (40,679,935 B) | 149 MB live after `JSON.parse` | rejected as `capacity` before `JSON.parse` |
| Occurrence read for one source | one 24.9 MB D1 result | 17 keyset pages of 250 rows (`OCCURRENCE_PAGE_ROWS`) |

Live provider sizes measured read-only on 2026-09-15 to confirm the ceilings keep
every reviewed board admissible: largest GitHub document 1.65 MB, largest Lever
page 1.94 MB (Palantir, 100 postings) and largest Lever board 6.1 MB / 316
postings, largest Ashby response 10.3 MB (Airwallex, 583 listed postings).

## Production attribution

Read-only telemetry captured during the #197 investigation (2026-09-16):

| Evidence | Value |
| --- | --- |
| `workersInvocationsAdaptive` 2026-09-10 | `exceededMemory` 73, `exceededResources` 22 |
| `workersInvocationsAdaptive` 2026-09-15 | `exceededMemory` 56, `exceededResources` 39 |
| Deployed version in the issue report | `32c8724c-ca42-4a02-a094-ea5cd7e94a40` |
| `simplify-summer-2026` health | `lastAttemptAt = 2026-09-09T19:40:13.703Z` while the other five GitHub sources attempted 2026-09-15T23:18-2026-09-16T00:09 |
| `intern-notifs-github-dlq` peek | 4× `simplify-summer-2026`, 1× `speedyapply-2027-ai`, 1× `speedyapply-2027-swe`, all `failureProvenance: missing-ledger` |
| `intern-notifs-destination-verification-dlq` peek | 35 visible, 21 from `simplify-summer-2026` |
| Greenhouse DLQ peek | `greenhouse-dropbox` 11, `greenhouse-rocketlab` 9, `greenhouse-andurilindustries` 3 (link failures, ledgered — not this defect) |
| Catalog scale | 9,874 internships / 144.3 MB; `simplify-summer-2026` 4,194 occurrences / 24.9 MB, `zapply-2027` 3,683 / 21.2 MB, `speedyapply-2027-swe` 1,442 / 8.5 MB; `simplify-summer-2026` checkpoint row 276,610 B |
| Boards by row count | spacex 2,456, andurilindustries 2,319, databricks 883, stripe 644; every other board ≤5.7 MB |
| Baseline queue depths (2026-09-16T00:4xZ) | waiting: greenhouse 1, lever 0, ashby 0, github 0; dead-lettered 82 / 6 / 2 / 188; `productionMetrics.deadLetterMessages` 278 |

## Bounds

| Bound | Value | Basis |
| --- | --- | --- |
| GitHub document | `GITHUB_DOCUMENT_MAX_BYTES = 8 MB` | 5× the largest observed document (1.65 MB) |
| GitHub source (all documents) | `GITHUB_SOURCE_MAX_BYTES = 16 MB` | checked before the document that crosses it is parsed |
| Greenhouse board | `GREENHOUSE_RESPONSE_MAX_BYTES = 16 MB` (was 64 MB) | 16 MB board ≈ 60 MB peak adapter heap, leaving room in the isolate |
| Greenhouse job | `GREENHOUSE_JOB_MAX_BYTES = 512 KB` | unchanged; now measured only for rows whose `content` can reach it |
| Lever page / board | `LEVER_PAGE_MAX_BYTES = 4 MB`, `LEVER_BOARD_MAX_BYTES = 16 MB` | 2× the largest page, 2.6× the largest board |
| Ashby response / postings | `ASHBY_RESPONSE_MAX_BYTES = 16 MB`, `ASHBY_BOARD_MAX_POSTINGS = 1_000` | 1.6× the largest response, 1.7× the largest board |
| GitHub listings per delivery | `GITHUB_RESOLUTION_ROWS_PER_DELIVERY = 200` | 750 rows aborted on the live five-minute message deadline (a `wallTime: 300147 ms` invocation in `wrangler tail`); 200 rows measured 2.6-3.6 s CPU and 30-79 MB heap per delivery locally |
| Occurrence page | `sourceOccurrencePageSize = 500` (already in `main` from #241) | 24.9 MB source read in bounded keyset pages; #197 adds the targeted `getSourceOccurrence` read instead of loading the partition to answer for one row |
| Catalog page (admission reads) | `CATALOG_JOB_PAGE_ROWS = 100` | the 144 MB catalog is walked in pages so no statement streams it into one D1 result |

`capacity` already routes to `sourceFailureOutcome → 'resource_limit'`,
`sourceBackoffUntil` (60 s × 2ⁿ capped at 30 min) and
`shouldQuarantine` at two consecutive capacity failures
(`CAPACITY_FAILURES_BEFORE_QUARANTINE = 2`), so oversized boards quarantine with
a naming diagnostic instead of silently killing the isolate. That quarantine is
the owner-selected outcome for `greenhouse-spacex` and
`greenhouse-andurilindustries`; per-posting two-phase acquisition for boards
above the ceiling is deliberately out of scope.

### Deviations from the approved plan, with measurements

- `GITHUB_RESOLUTION_ROWS_PER_DELIVERY` was lowered from 750 to **200** after the
  first deploy: the live ingestion worker wraps a poll in a five-minute message
  deadline (`SOURCE_MESSAGE_DEADLINE_MS`), and a 750-row slice measured a
  `wallTime: 300147 ms` abort for `simplify-summer-2026` — the delivery never
  completed, so its message retried forever without writing a health row. 200
  rows keeps a delivery near a third of that budget. This is the plan's stated
  contingency ("lower the constant in `src/poll.ts` — the pass is resumable").
- `ASHBY_RESPONSE_MAX_BYTES` is **16 MB, not 8 MB**: the live `ashby-airwallex`
  board responded with 10,275,838 bytes / 583 listed postings on 2026-09-15, so an
  8 MB ceiling would have quarantined a healthy source. 16 MB keeps every live
  Ashby board admissible while still bounding a runaway body.
- Resuming a bounded pass clears only the request validators (`etag`,
  `documentEtags`), not `contentHash`: the hash cannot produce a body, and
  clearing it made every resumed delivery report a spurious source change.
  `resolutionFullBody` is what keeps the pass progressing on an unchanged body.
- The original fix shared one complete occurrence read between trusted-community
  revocation and reconciliation. The 2026-09-28 follow-up replaces that read on
  bounded GitHub deliveries with targeted full-row hydration plus compact D1
  projections; unbounded callers retain the shared-read behavior.
- The Greenhouse per-job guard now measures only when `job.content` can reach the
  limit; a row whose serialized projection exceeds 512 KB while its `content`
  stays under 512 KB code units is no longer rejected. Worst case that row is
  ≤~2 MB and still bounded by the 16 MB board ceiling.
- Runtime coverage: `PollReport.pendingResolution` reports the remaining slice
  per source, and the `github_admission_migration_slice` log line carries it as
  `resolutionPending`.

## Verification

```bash
npx tsc --noEmit
npx vitest run --dir test test/ingestion-resource-budget.test.ts
NODE_OPTIONS=--expose-gc npm run test:budget
npm run test:e2e
```

Regression coverage:

- `test/ingestion-resource-budget.test.ts` — production-shaped HTML-table parse
  under `PARSE_CPU_BUDGET_MS = 1,000` with row numbers equal to the previous
  prefix-slice expression; per-delivery CPU under `MESSAGE_CPU_BUDGET_MS = 9,000`
  and peak heap under `MESSAGE_HEAP_BUDGET_MB = 96` for the largest GitHub source
  while resolving exactly the configured `GITHUB_RESOLUTION_ROWS_PER_DELIVERY`
  slice per delivery (and the tail); the 2026-09-28 shape retains 5,337 rows /
  39.5 MB while each measured delivery hydrates exactly its 25 selected occurrence
  bodies. Historical paged-read coverage remains based on the 4,194-row snapshot.
- `test/fixtures/production-scale.ts` — in-process generators sized from the
  measured production values (no multi-megabyte fixture is checked in).
- Provider ceilings and `capacity` classification in `test/greenhouse.test.ts`,
  `test/lever.test.ts`, `test/ashby.test.ts`, `test/sources.test.ts`; the
  two-consecutive-failure quarantine in `test/source-health.test.ts`.
- The Greenhouse content-hash pin `cf446ff527e4e1a987a31f376a33ad3a6cbb93316ce917ab897f7dbaaa621641`
  (captured from the pre-change implementation) proves the folded
  `projectionHash` still produces the same value.
- Bounded resolution pass, forced re-read on resume, and pass completion in
  `test/poll.test.ts`; the GitHub queue re-enqueue in `test/cloudflare-worker.test.ts`;
  employer-title accumulation in `test/processor.test.ts`; one compiled-worker
  GitHub+Greenhouse+Lever+Ashby cycle in `test/e2e/api-ingestion-split.e2e.mjs`.
- `.github/workflows/ci.yml` runs `npm run test:budget` after `npm test` so the
  heap assertion always executes with `--expose-gc`.

Gate results for this change (2026-09-16):

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint .` | clean |
| `npx vitest run --dir test --maxWorkers=2 --fileParallelism=false --testTimeout=120000` (isolated #197 tree) | 125 files / 1,680 tests pass, 0 fail |
| same, shared working tree | 126 files pass; 1 foreign failure in `test/source-operations.test.ts` (the concurrent session's uncommitted `overduePublishedSources` metric vs its own new test; the HEAD version of both runs green in the isolated tree) |
| `npm run test:budget` | 3/3 pass; per-delivery CPU 2.6-3.6 s, heap growth 30-79 MB, absolute ≤106 MB |
| `npm run test:e2e` | 13/13 pass (the production-scale cycle case takes 132-167 s), in both trees |

`--maxWorkers=2 --fileParallelism=false` was needed only because this workstation
ran at load average ~190 from concurrent sessions; the default worker count made
unrelated D1/CDK tests exceed their own five-second limits.

## Post-deploy reconciliation

Procedure (owner-approved): build both Workers, confirm the deployed consumer
settings are unchanged, `tofu -chdir=infra/cloudflare plan`/`apply`, observe at
least one cadence window (≥35 minutes) with
`npx wrangler tail intern-notifs-ingestion --format json --config wrangler.ingestion.jsonc`,
then compare resource outcomes for the deploy date against the preceding 7 days:

```
workersInvocationsAdaptive(scriptName: "intern-notifs-ingestion",
  status: "exceededMemory" | "exceededResources",
  date_geq: <deploy-7d>, date_leq: <deploy+1d>) grouped by scriptVersion, datetime
```

Success criteria: zero `exceededMemory`/`exceededResources` invocations for the
new script version, `simplify-summer-2026` attempting within two cadences
(`lastAttemptAt` newer than the deploy) and dropping out of
`productionMetrics.staleSources` / `overduePublishedSources`, work-queue depth not
growing from the baseline above, and DLQ depth falling after the guarded replay
of the stranded messages (the `simplify-summer-2026` + `speedyapply-*` entries in
`intern-notifs-github-dlq` and the `simplify-summer-2026` entries in
`intern-notifs-destination-verification-dlq`), with every other DLQ record left
untouched. `plan` refuses paused or quarantined catalog sources, so
`simplify-summer-2026` is recovered (`recover`, then `resume`) if its first
successful poll has not already cleared the state.

### Deploy record (2026-09-16)

The deploy ran from an isolated worktree holding `HEAD` plus only this change, so
the artifact was reviewable on its own:

| Item | Value |
| --- | --- |
| Worktree / branch | `/tmp/197-pr` on `fix/issue-197-ingestion-resource-bounds-2` (merged `main` `0bb1548` + this change); the first deploy came from the earlier `/tmp/deploy-197` tree based on the pre-#244 `main` |
| Gate before deploy | isolated tree on pre-#244 `main`: `eslint` clean, `tsc` clean, 125 files / 1,680 tests green, `test:budget` green, `test:e2e` 13/13. Final tree on merged `main` (`/tmp/197-pr`): `eslint` clean, `tsc` clean, 128 files / 1,731 tests green, `test:budget` 3/3, `test:e2e` 13/13 |
| Apply | `tofu -chdir=infra/cloudflare plan`/`apply` — 0 added, 2 changed, 0 destroyed (ingestion `7ae9e7130aa08106dd178b83377700c8e84b1bfd1f00a31eeaccba487e594fbd` / version `3fd888f0-1617-4ee2-b772-132451ce01ad` at `05:10:19Z`, api `553c5ba87d49c7b03186c10bbcc85daa0a752d509bbaa24f4ca5594e85310518`) |
| Base revision | merged `main` after PR #244 (`0bb1548`), which carries the #240 dispatch/lease/deadline work; only the two Worker scripts changed, consumer settings untouched |
| Superseding deploy | 90 s later a concurrent session applied the shared working tree, which by then contained both its own dispatch work and this change: ingestion `bff96c09815f1c629efd93dec8215c244ab67b92b7f3a9f76e3ec5490549ec64` / version `3c9575c7-5635-4840-94f3-d9ec0ae58d35` at `03:45:33Z`, api `07e9674d3e1cdcf2bd5a3490fd89917afbb5964d5b6ae5424212d62f282f6140` / version `dbf9df6d-7fd1-41dd-8470-9d33e62b53bb` at `03:45:36Z` |
| Live bundles verified | Both deployed `content_sha256` values are byte-identical to fresh builds of the working tree (which contains this change), so the running code carries the bounds even though the isolated apply was superseded |
| Consumer settings after deploy | greenhouse `max_concurrency` 6, lever 2, ashby 2, github 2, every `batch_size` 1, `max_retries` 2 (unchanged; the targeted apply deliberately left the concurrent session's concurrency sizing in place) |
| Observation window | measured from `03:45:33Z` to `04:20Z`+ on version `3c9575c7` |

Before-picture measured by this deploy, same read-only APIs the after-picture
uses (`simplify-summer-2026` shows the defect signature: no health row for six
days while the source reports `active`):

| Evidence (2026-09-16T03:47Z) | Value |
| --- | --- |
| `simplify-summer-2026` | `state: degraded`, `lastAttemptAt = 2026-09-09T19:40:13.703Z` (age 547,477 s), `consecutiveFailures: 0`, `sourceStatus: active`, `quarantined: false` |
| Work queues (waiting) | greenhouse 0, lever 0, ashby 0, github 17 |
| Dead-lettered | greenhouse 81, lever 6, ashby 2, github 202 |
| `productionMetrics` | `deadLetterMessages` 291, `staleSources` 3, `quarantinedSources` 3, `pausedSources` 3, `queuedMessages` 17 |
| `intern-notifs-github-dlq` (visible) | 3× `simplify-summer-2026`, 1× `speedyapply-2027-swe`, 1× `speedyapply-2027-ai`, 1× `canadian-tech-2027`, all `missing-ledger` |
| `intern-notifs-destination-verification-dlq` (visible) | 74, of which 47× `simplify-summer-2026`, 5× `speedyapply-2027-ai`, 1× `speedyapply-2027-swe` |
| Live invocations with a resource outcome (ingestion, adaptive sampling) | 09-09: memory 5 / resources 1; 09-10: 19 / 3; 09-11: 7 / 3; 09-12: 1 / 4; 09-13: 0 / 4; 09-14: 6 / 5; 09-15: 13 / 6; 09-16 (pre-deploy): 5 / 1 |

Observed results are appended here after the observation window.

### Observed results (2026-09-16, window from 04:13Z)

The live ingestion `content_sha256` is `594cea6ef3226b623a0dcf868a8f9660f1ee4626e5b74a91a6b0b5838ac8cdae`
(both Workers applied at `04:13:17Z`; tofu state re-read at `04:16:24Z` confirms the
same content), and the consumer settings are unchanged.

**Resource outcomes.** Ingestion invocations in the window, grouped by status
(`workersInvocationsAdaptive`): **127 `success`, 0 `exceededMemory`, 0
`exceededResources`, 0 `exceededCpu`**, 1 `scriptThrewException`. For comparison,
the same query for 2026-09-16 *before* the deploy returned `exceededMemory` 5 and
`exceededResources` 1 (and every day of the preceding week carried both).

**The stranded source advances.** `simplify-summer-2026` had not attempted a poll
since `2026-09-09T19:40:13.703Z` while reporting `sourceStatus: active` and
`consecutiveFailures: 0`. After the deploy:

| Event | Value |
| --- | --- |
| First delivery (`source_fetch_completed`) | `success_changed`, 3,055 raw rows / 2,534 eligible, `SourceFetchDurationMs` 40,722 |
| Slice marker (`github_admission_migration_slice`) | `continuation: true`, `resolutionPending: 2847`, `failureCount: 0` |
| Following deliveries | `resolutionPending` 2847 → 2647 → 2647 → …, i.e. 200 rows resolved per delivery, one re-enqueued continuation per delivery |
| Source health | `state: healthy`, `lastAttemptAt 2026-09-16T04:16:01.578Z`, `consecutiveFailures: 0`, `sourceStatus: active`, `rawRows: 3055`, `eligibleRows: 2534` |

**Why the slice is 200 and not 750.** The live worker wraps a poll in a
five-minute message deadline, and `wrangler tail` recorded invocations ending
`wallTime: 300147` with `{"command":"github-poll","error":"message deadline: the
operation timed out after 300000 ms"}` for the stranded sources under the 750-row
slice: those deliveries never completed, so the messages retried without ever
writing a health row — the same silent-loop shape as the original defect. At 200
rows a delivery costs 40-47 s wall (2.6-3.6 s CPU locally), so the pass for this
source completes in ~15 deliveries instead of looping forever.

**Queue depths.** github `waiting` 17, `deadLettered` 193 (the 17 waiting are the
pass's own continuations plus dispatches; the DLQ count fell from 202 during the
window). Greenhouse/lever/ashby remain drained at 0 waiting with 81/6/2
dead-lettered, unchanged from the before-picture.

**Guarded DLQ replay: not applied.** Four `plan` attempts per queue returned 409
`Selection drift: one or more messages are no longer visible`; on the single
attempt where a one-message plan succeeded (`github`, `planId
bfee0b67-c69f-4d9f-8f0f-77b4f8d65c29`), the `apply` still returned 409
`Selection drift: planned messages changed or are no longer visible` within the
same second. The visible DLQ window is rotating faster than a plan/apply round
trip, so the guarded replay needs a quiet window (or the concurrent session's
operations to finish). Nothing was discarded or replayed, and every DLQ record is
left as it was; the stranded messages also stopped being produced once the
bounded delivery landed, so no new records accumulate.

### Additional production findings (same observation window, out of this plan's scope)

Two defects surfaced while observing the deploy. Both are now resolved, and the
guarded DLQ replay is closed with a measured determination.

**1. The unpaged catalog scan killed the scheduled handler — fixed here.** The
live ingestion worker threw this on *every* `9-59/10` cron run:

```
"message": "D1_ERROR: Memory limit exceeded before EOF."
  at D1CatalogAdmissionStore.reviewSampleCandidates
  at enqueueDueDestinationVerifications
  at Object.scheduledHandler [as scheduled]
```

`workersInvocationsAdaptive` showed `scriptThrewException` at exactly `:49:48`
past every hour mark — `03:49:48`, `03:59:48`, `04:09:48`, `04:19:48`, `04:29:48`,
`04:39:48`, `04:49:48`, `04:59:48`, `05:09:48` — so the destination-verification
enqueue never completed. Cause: `reviewSampleCandidates` and
`legacyVerificationCandidates` each ran
`SELECT value FROM catalog_items WHERE kind = 'internship'` with no `LIMIT`,
streaming the whole 9,874-job / 144 MB catalog into one D1 result.

Fix: both readers now walk the catalog through a private `catalogJobPages()`
keyset generator (`WHERE kind = 'internship' AND (pk, sk) > (?, ?) ORDER BY pk, sk
LIMIT ?`, `CATALOG_JOB_PAGE_ROWS = 100`), so a caller that finds its sample early
never reads the rest. Verified in production: the `05:19:48` cron — the first one
after the fix — reports `success` and no `scriptThrewException`, where the same
minute failed on the nine preceding runs. Regression:
`test/catalog-admission-store.test.ts` seeds 251 jobs, puts the only rule-matching
candidate on the last page, and asserts it is found while every executed catalog
scan carries a `LIMIT` and more than two scans are issued; on the unpaged
implementation the same test fails with `expected 2 to be greater than 2`.

**2. The GitHub lane stall resolved with the merged dispatch work.** Before the
merge, GitHub work messages sat undelivered while the other fleets were idle
(8 messages, oldest `04:15:03Z`, no delivery for 24 minutes). After deploying
merged `main` (per-source dispatch leases plus failed-delivery health recording),
the same queue drains: `backlogCount` 8 → 1, and `simplify-summer-2026` attempted
at `05:18:00Z` and kept advancing its bounded pass. No concurrency change was
made: measurement did not support rebalancing the #240 sizing, and the stall
matched the hung-invocation shape that PR defers to its own issue.

**3. Guarded DLQ replay — closed as not applicable.** Four `plan` attempts per
queue returned 409 `Selection drift: one or more messages are no longer visible`,
and the single one-message plan that succeeded drifted before `apply`. A timed
experiment explains it: two DLQ peeks 45 seconds apart returned 20 and 6 message
ids with **zero** overlap, so the tooling's own plan/apply peeks cannot agree on a
set. Independently, the replay would duplicate work rather than recover it — every
source whose messages sit in those DLQs has polled successfully since
(`simplify-summer-2026` 05:18:00Z, `speedyapply-2027-swe` 04:14:20Z,
`speedyapply-2027-ai` 04:15:04Z), which matches the #240 record's determination
for the same backlog. Nothing was replayed or discarded.

**4. The scheduled handler also owns catalog publication — the freeze window.**
Reported by the owner as "the web and mobile just aren't showing the new
postings". The same cron failure above had a second consequence: the handler runs
`enqueueDueDestinationVerifications` *before* `refreshCatalogProjection`, so while
the unpaged scan threw, the projection was never rebuilt either. Measured in
production:

| Evidence | Value |
| --- | --- |
| Newest role in the served catalog | `updatedAt 2026-09-15T14:14:39Z` — publication stopped at that minute and stayed stopped until the fix deployed |
| Cron outcome before the fix | `scriptThrewException` at `:49:48` past every hour (`…04:49:48`, `04:59:48`, `05:09:48`) |
| Cron outcome after the fix | no `scriptThrewException`; projection `generatedAt` refreshed to `13:32:09Z` |
| Admission evaluations resumed | 767 in the 13:00Z hour, 27 of them newly `catalogEligible` (Tenstorrent, Toshiba, Meta — visible in the app) |

So the projection and re-admission are working again. What still hides *new*
postings is a deliberate publication gate, not a fault: 101 of the day's 102 new
rows come from `simplify-summer-2026` and all carry
`reasonCodes: ["employer-unresolved"]`, because production runs with
`TRUSTED_COMMUNITY_CATALOG_ENABLED=false` (the policy that would classify them
`employerResolution: source-reported` and admit them once their destination
validates as `posting-detail`/`application-form`) and only 35 reviewed
`employer_mappings` rows exist (github 7, greenhouse 23, plus tesla, meta, imc,
janestreet, goldman-sachs). `IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED=false`
additionally withholds the 2,093 open jobs whose posting identity is unconfirmed.
133 open jobs of 5,836 are `catalogEligible`. 5,138 destination-verification rows
are due, draining through a consumer with `max_concurrency: 1`.

Resolved the same day, on the owner's decision to treat the reviewed community
lists as trusted sources:

| Change | Effect |
| --- | --- |
| `TRUSTED_COMMUNITY_POLICIES` covers all six reviewed lists (`simplify-summer-2026` plus `vanshb03-summer-2027`, `speedyapply-2027-swe`, `speedyapply-2027-ai`, `northwestern-fintech-2027-quant`, `canadian-tech-2027`), each with its own policy version and `alertMode: 'disabled'` | Admission-valid rows publish with `employerResolution: 'source-reported'` instead of blocking as `employer-unresolved`; membership is an explicit reviewed list, never inferred from the polled registry |
| `TF_VAR_trusted_community_catalog_enabled=true` | Opens the catalog gate; the policy version re-grades existing rows, and alerts stay disabled |
| `trustedFullBody` now also requires a policy whose `alertMode` is not `disabled` | Catalog exposure alone no longer re-resolves every listing of a trusted list on every poll (3,029 rows for the largest); the full-body refetch returns when an alert mode is activated, which is the only consumer of the snapshot streak |

Still open for the same class of coverage: roles from *manually reviewed provider
boards* whose employer has no `employer_mappings` row (for example
`greenhouse-genscript`), and the 2,093 open jobs withheld by
`IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED=false`.

### Recurrence: the projection write itself (2026-09-17)

The freeze returned through the step that had been the remedy. `putCatalogProjection`
chunked its `INSERT`s into batches of 50 statements — a bound on statement count,
not on payload — while the projection is a copy of the whole catalog, so the write
grew until it crossed D1's per-RPC argument ceiling and every refresh threw on it:

```
D1_ERROR: Serialized RPC arguments or return values are limited to 32MiB,
but the size of this value was: 69751177 bytes
  at D1InternshipStore.putCatalogProjection (d1-store.ts)
  at refreshCatalogProjection (worker.ts)
  at Object.scheduledHandler [as scheduled]   // cron 9-59/10 * * * *, 16:49:42Z, wall 86s
```

| Evidence | Value |
| --- | --- |
| Newest role in the served catalog | `2026-09-16T19:47:31Z` — the last refresh whose write fit, 21 h behind `/jobs` (`2026-09-17T15:21:44Z`) |
| What the feed showed | a day-old `employer-release` card for IMC whose four member jobs no longer existed (`/jobs/<id>` returned 404) beside the live individual cards for the same four postings — a group that duplicated them |
| Measured projection | 2,608 groups / 80.6 MiB serialized; the old batching sent 35–39 MiB per `batch()` before D1's envelope inflated it |
| Cron outcome before the fix | `outcome: exception` with the D1 32 MiB error on every `9-59/10` run |

Two changes: the write is budgeted in payload bytes (`CATALOG_PROJECTION_BATCH_BYTES`
per `batch()` and a per-statement budget, so a single oversized group cannot pass
either), and the maintenance cron rebuilds the projection *before* its remaining
steps and isolates each one's failure, so a failing alert or verification email can
no longer hold publication back.

Still growing with the catalog: the projection carried 80.6 MiB on 2026-09-17 and
is written in 11 batches. The refresh now ships only the cards that changed
instead of a full copy. Cards are stored under the group's own identity with a
content-addressed suffix and ordered by a key the card carries, so a changed tick
writes the changed cards plus a compact active-key manifest and pointer. Readers
select only that manifest's cards. Retired cards are deleted after a two-minute
reader grace period; an unchanged tick costs one pointer row when no cleanup is due.

Measured on 2026-09-24 against a 300-card local simulation (~8.8 MB of cards):
a full publish wrote 12 card statements, and a one-card refresh wrote one card
statement / 20.5 KB, plus the manifest and pointer rows. At the deployed size the version this
replaced wrote 2,608 cards and deleted the 2,608 from the previous version on
every changed tick. The first refresh after the deploy still rewrites every card
once: a version-4 copy is stored under its version's key and cannot be reused.

## 2026-09-29 maintenance-cron memory isolation

The combined `9-59/10` maintenance cron still terminated on the 128 MB isolate
limit after the projection write landed. The last recorded failure published a
fresh D1 projection (`generated_at 2026-09-29T16:21:17.491Z`, version
`0bf5d72e4ea9cfdc6b26`), then exceeded memory 28 s later with no buffered console
output, so the surviving evidence could not say whether termination happened
inside R2 publication or in a later maintenance phase. PR #444's one-invocation
memoization stopped a failed projection from being retried in the same run, but a
single invocation still carried both the memory-heavy projection and every
observability, alert, and notification phase.

Two changes bound that invocation:

1. **Dedicated catalog-projection crons.** `1-51/10 * * * *` owns
   `runCatalogProjectionMaintenance` — prospective shadow publication and the
   D1 projection write — and nothing else. `4,14,24,34,44,54 * * * *` reads that durable
   projection in bounded 25-card pages and publishes the R2 mirror in a fresh
   isolate after D1 invalidates the old R2 pointer. It does not retain the raw
   internship rows or repeat grouping. The `9-59/10` cron keeps only the
   remaining maintenance phases. Each expensive phase has
   exactly one cron owner: the projection cron is the only scheduled caller of
   `listCatalog`, `putCatalogProjection`, and `R2CatalogProjection.publish`, and
   no phase is run from both schedules. Operator-triggered routes also call
   `refreshCatalogProjection`, but they are request-scoped, not scheduled. The
   separate invocations prevent the D1 and R2 projection heaps from accumulating
   in one 128 MB isolate. The `1-51/10` slot also keeps three
   minutes between its nearest minute (`:31`) and the daily write-heavy
   retention cron at `34 8`.
2. **Durable phase markers.** `cloudflare/maintenance-phases.ts` writes a small
   `system_state` row (`maintenance_phase:<scope>:<phase>`) when each phase starts
   and again when it finishes or fails. A memory termination cannot flush console
   logs, so the last `started` marker without its `complete` is what identifies the
   failing phase. Markers are best-effort: an overloaded D1 logs
   `maintenance_phase_marker_failed` rather than failing the phase. The projection
   cron brackets `prospective_shadow_metadata`, `catalog_projection`,
   `catalog_projection_d1`, `catalog_projection_r2`, and
   `catalog_projection_complete`; the maintenance cron brackets every step
   through `runScheduledStep` and records `maintenance_complete` last. Markers
   are last-write-wins: a deterministic kill repeats the stuck `started` marker
   on every run, while an intermittent kill is only visible until a later run
   completes that phase.

R2 generation is unchanged and still serializes the complete catalog, so a
projection that cannot fit one isolate is not yet excluded. Streaming or chunking
that serialization remains the follow-up if the isolated projection cron still
exceeds memory; the cron split is the first containment because it preserves the
same ordering and freshness contracts while removing the accumulation.

## 2026-10-01 GitHub aggregator rebound

Status: open follow-up. The catalog-admission alert at 2026-10-01T02:06Z reported
`dlq-growth` (github) and `source-failure-persistence`, and the resource kill that
`#197` bound has returned on the GitHub aggregator lane.

### What the alert actually was

- The catalog was healthy: 2,455 eligible roles and a newest published role 2.9 h
  old, far inside the 24 h starvation threshold. D1 overload failures were zero
  and the destination-verification queue drained from 50 to 0.
- The `dlq-growth` signal was one new dead-letter: a `simplify-summer-2026` poll
  enqueued at 2026-10-01T01:55:23Z, plus a second at 02:20:30Z while the incident
  was being triaged. Both arrived in the GitHub DLQ with **no** matching
  `queue_failure_events` row (`missing-ledger`) and no failure-ledger marker.
  That is the resource-kill signature: a kill writes no health row and bypasses
  the failure ledger, so the message retries silently and dead-letters.
- Invocation analytics confirm it. For the 01:00-02:30Z window the ingestion
  Worker recorded three `exceededMemory` invocations, plus `scriptThrewException`
  and `clientDisconnected` invocations in the surrounding hours.
- The two `persistence` failures in the alert were both
  `D1 statement did not settle within 20000 ms` — `resilientD1`'s per-attempt
  ceiling, which `d1-errors.ts` classifies `stalled` and retries in-request. One
  (`speedyapply-2027-swe`) self-resolved; `simplify-summer-2026`'s remained
  unresolved beside five `transport` message-deadline rows. These are transient
  stalls, not ingestion defects; `sourceFailureCategory` now classifies the stall
  text as `transport` so a retried stall no longer reads as an unresolved defect
  (see `src/source-health.ts`).

### Growth since the 2026-09-28 bound

`simplify-summer-2026` retains **5,403** `source-occurrence` rows (5,337 on
2026-09-28, per the section above). The retained partition is large enough that
related D1 reads are themselves expensive:

| Observation (2026-10-01) | Value |
| --- | --- |
| `simplify-summer-2026` source-occurrence rows | 5,403 |
| A per-source occurrence count (`source_id = ? AND kind = 'source-occurrence'`) | **71.8 s**, 443,926 rows read |
| `catalog_items` size | 8.26 GiB (8,866,451,456 bytes) against D1's ~10 GB cap |
| An ad-hoc scan of `catalog_items` | returned `D1_ERROR … Upstream service unavailable [code: 7009]` |

The 2026-09-28 fix hydrates occurrence JSON only for the selected slice, but the
durable checkpoint (identity list for the pending pass) and the per-delivery
projection share of the partition still scale with retained history. The largest
board stays the outlier: `simplify-summer-2026` fetches two documents totalling
~2.7 MB and yields 3,370 raw / 2,934 eligible rows.

### Proposed follow-up (draft; profiling first)

1. Re-measure the per-delivery peak heap for one bounded `simplify-summer-2026`
   slice at current retention, using the `test:budget` harness. Record the number
   in this section before changing a bound.
2. If the peak scales with retained occurrence bytes rather than slice size,
   bound the hydrated projection to the slice's own external ids and read
   occurrence JSON lazily, instead of materializing the whole partition.
3. Pin the per-delivery heap against a fixture with the current retained shape in
   `test/ingestion-resource-budget.test.ts`, so a future growth spurt fails the
   budget rather than a production delivery.

Acceptance criteria: no `exceededMemory` on the ingestion Worker across two full
GitHub cadences; the GitHub DLQ holds no `missing-ledger` entry for a reviewed
source; and `simplify-summer-2026` / `speedyapply-2027-swe` record a
`lastAttemptAt` inside one cadence.

### Post-deploy recurrence (2026-10-01T04:30Z)

The rebound continued after the 03:23Z deploy of the alert-classification change
(which does not touch memory). Invocation analytics recorded `exceededMemory` at
03:13:37, 04:19:29, 04:23:14 and 04:23:35Z, plus `scriptThrewException` and
`clientDisconnected` around 03:00-03:13Z. A `failure-ledger-unavailable` marker was
written at 03:05:51.550Z for a `simplify-summer-2026` message, the same instant
Ashby sources hit `D1 DB exceeded its CPU time limit` (`capacity`). Two more
`missing-ledger` GitHub dead-letters followed.

The memory-heavy steps are named in `refreshCatalogProjection`: it holds
`groupCatalogJobs(await store.listCatalog(), { includeClosed: true })` plus a full
`catalogGroupDetails` projection for every group in one isolate, then serializes
each group again in `putCatalogProjection`.

### Bounded admission-migration selection

The live trigger was `pendingAdmissionConfigurationVersion` on the large trusted
community lists. While it was set, the GitHub lane disabled bounded hydration
(`!admissionConfigurationChanged && !metadataVersionChanged`) and called
`getSourceOccurrences`, which loads every retained occurrence body.
`simplify-summer-2026` retains 5,403 occurrences (~40 MB of JSON), so the delivery
crossed the 128 MB isolate, was killed, and never completed the migration — and
the next delivery repeated the full load against an unchanged checkpoint.

The lane keeps bounded hydration whenever `maxListingsPerSourceRun` is set and
selects the slice from a new compact projection,
`listSourceOccurrenceSelectionMetadata` (external id, presence, state, admission
configuration version, material hash, publication flag — no bodies). Occurrence
bodies are read by external id only for the chosen migration rows and closures.
Production-scale regression coverage lives in
`test/ingestion-resource-budget.test.ts` (a pending migration must not call
`getSourceOccurrences`) and `test/github-ingestion-day.integration.test.ts`.

The catalog-projection build above still materializes the whole catalog and every
group's roles. If `exceededMemory` recurs at projection cron minutes
(`1,11,21,…:01`) rather than at consumer minutes, that build is the next target.

## 2026-10-01 ingestion V2 Stage 1 shadow discovery

Ingestion V2 Stage 1 adds a shadow discovery pass that normalizes the complete
board, stores a content-addressed snapshot in R2, and diffs it against a compact
`ingestion_rows` ledger. It is default-off behind
`INGESTION_V2_SHADOW_DISCOVERY_ENABLED`.

The pass is bounded by IDs, not by retained history:

- The diff reads `ingestion_rows` through `listLedger`, which selects only the
  compact columns (identity, material hash, admission version, state, retry,
  omission count). No occurrence body, catalog JSON, or occurrence-history scan is
  on this path.
- The R2 snapshot is one object per complete board under
  `ingestion-v2/snapshots/<source-id>/<snapshot-hash>.json`; an existing
  content-addressed object is fully validated and reused, never rewritten. A
  later A -> B -> A board transition reactivates the retained A object and
  clears its terminal retention markers instead of leaving the ledger on B.
- Actionable work is the set of IDs classified `new`, `changed`, `stale-policy`,
  `reappeared`, or due `retryable`. A board with five changed rows is five
  actionable IDs regardless of how much retained history the source holds.

Regression coverage lives in `test/ingestion-resource-budget.test.ts`
(`plans shadow discovery from compact metadata without hydrating retained
history`): a production-shaped GitHub board is diffed against a 20,000-row
settled history with five changed rows, asserting five actionable IDs, the full
ledger read count, no catalog/occurrence query on the path, and the per-message
CPU/heap budget. `test/ingestion-v2-shadow.integration.test.ts` covers the
new/changed/second-document/reappearance/two-snapshot-omission/incomplete/
idempotent/content-reactivation scenarios. `test/ingestion-v2-unit.test.ts`
rejects envelope metadata or posting provenance that disagrees with its derived
canonical values, and `test/e2e/ingestion-v2-shadow.e2e.mjs` runs the built
ingestion Worker against local D1/R2/queues to confirm the shadow object, ledger,
idempotent replay, and the protected operations response.

## 2026-10-01 ingestion V2 Stage 2 fault-isolated admission

Stage 2 adds the dedicated `intern-notifs-admission-v2` queue and DLQ and a
leased, idempotent row consumer. It is default-off behind
`INGESTION_V2_ADMISSION_ENABLED` and, before Stage 3 cutover, commits through a
recorded decision sink rather than the live catalog.

The admission lane is bounded in four independent ways:

- One queue message carries at most 25 external IDs, so a delivery's work is
  bounded by the message, not by the source's retained history.
- Bulk row reopening carries at most 96 IDs plus four fixed bindings per D1
  statement. A 200-row policy slice or larger discovery diff therefore runs as
  several bounded statements instead of exceeding D1's parameter limit.
- The consumer downloads the referenced snapshot once per batch, never once per
  row (`test/ingestion-v2-admission-queue.test.ts` asserts one read for a 25-row
  batch).
- `test/ingestion-resource-budget.test.ts` also drives a 25-row admission message
  through the real D1 repository and R2 response-body reader using the measured
  3,302-row `simplify-summer-2026` board. The test enforces the same 9 s CPU,
  96 MB attributable-heap, and 112 MB absolute-heap ceilings as the production
  ingestion budget.
- Each row is leased with a bounded expiry; an expired lease is reclaimed and
  redispatched. Two concurrent consumers race for the same row through the
  conditional lease, so only one evaluates it
  (`test/ingestion-v2-admission.integration.test.ts`).
- The retry schedule is fixed (60 s, then 5 min) and a row is quarantined after
  the third failed attempt. A systemic failure releases the lease without
  consuming an attempt, so D1 pressure cannot manufacture quarantines.

The scheduled dispatcher covers up to 500 active sources per pass, bounds each
source to 500 candidate rows, and records a durable handoff per message; a source
with no due work produces no messages. Shadow-observed rows that have never
completed V2 admission bootstrap in 200-row silent batches. `test/ingestion-v2-admission-queue.test.ts` covers message validation,
the failure taxonomy, the state machine, retries/quarantine, duplicates, stale
deliveries, snapshot-once, and consumer contention; the integration suite covers
the real D1 transitions and guarded replay; and
`test/e2e/ingestion-v2-admission.e2e.mjs` runs the built ingestion Worker
against local D1/R2/queues to settle a board, quarantine a permanently failing
row without touching its peers, treat a duplicate and a stale delivery as
no-ops, prove the disabled consumer leaves row state untouched, and exercise the
guarded operations replay.

## 2026-10-03 ingestion V2 Stage 3 bounds

Stage 3 keeps the same 25-ID queue-message and 96-ID D1 update bounds. Bootstrap
reads one complete active R2 envelope and the compact active ledger once, then
uses one transactional D1 batch: one set-based row update, one checkpoint upsert,
and one immutable receipt insert. It copies no retained historical row bodies and
writes no R2 object. The dry-run reports the exact active/actionable counts and an
estimated D1 write count before apply.

After ownership transfer, the legacy poll still performs the bounded source fetch,
quality check, normalized snapshot write, and source health/checkpoint write. It
does not resolve every listing or execute catalog/occurrence/notification writes
for that source. Admission keeps row-local leases and retries, so one poison row
cannot expand a source delivery or block a valid peer. The Stage 3 E2E rehearsal
asserts silent baseline, a single new-role receipt, duplicate suppression,
unchanged zero work, two-cadence closure, rollback, and re-enable through the
built Worker with local D1, R2, and queues.

## 2026-10-07 catalog projection retention

Production memory p99 reached 126.9 MiB after enabling discovery for Figma,
Palantir, and Mistral AI. Catalog and admission checks passed, but the 120 MiB
headroom gate blocked further fleet expansion.

`refreshCatalogProjection` retained its raw job array in a suspended async frame
through D1 publication and R2 pointer validation. Those objects carry admission
and identity data that the projected cards do not need. Grouping now finishes in
a separate helper before either publication await, so the raw objects can be
collected while the projected roles retain their required source references.

A local 4,500-role fixture built from 100 current production samples retained
159.6 MiB with the old scope and 109.8 MiB after releasing it. Both runs produced
the same ordered catalog digest. The GC-enabled resource regression fails on the
old implementation with 1,000 live raw job objects and checks collection during
both the D1 write and R2 validation, while preserving all role IDs and provenance.
These local measurements do not establish Cloudflare headroom: the repaired
exact-version runtime still needs independent production observation before the
expedited source cohorts advance.

### Projection input hydration and fleet control bounds

PR #514 released raw catalog jobs before D1/R2 publication awaits, but the next
production projection still reported 137.4 MiB memory p99 on its minute sample
with no runtime errors. That leaves the resource-headroom gate pending.

The projection-only D1 read now removes unused top-level destination diagnostics,
posting-identity evidence, notification state, and non-audience role metadata
before hydration, and reads 25 composite-key rows per page. Normal job/API reads
still return their complete records. Catalog grouping keeps its original inputs
for employer identity, eligibility, education, posting status, and all source
references; output ordering and public card content must remain unchanged.

A representative 4,500-role local fixture measured grouped heap at 133.3 MiB
instead of 158.0 MiB (about 24.7 MiB less), with identical ordered catalog hashes.
This is a local comparison, not proof of live Worker headroom. Require a completed
natural projection and producer/R2 cycle on the deployed revision before expansion.

Explicit V2 source allowlists are limited to 8 KiB by the deployment guard. The
344-source production list is approximately 6.8 KiB and exceeded the old 1,000
character canary limit. Wildcards, invalid source-list characters, unrelated
binding changes, and values above the bound remain refused.
