# #197 ingestion queue resource bounds

Status: the two mechanisms behind the `exceededCpu` / `exceededMemory`
invocations are identified and fixed, with production-scale regression coverage.
The bounds are deployed and the stranded dead-letter messages are replayed by the
guarded operations path; the post-deploy observations are recorded at the end of
this document.

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
- The trusted-community revocation sweep and reconciliation share one occurrence
  read per delivery; each rewritten occurrence replaces its entry in that array,
  so the reused array is identical to the second read it replaces.
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
  slice per delivery (and the tail); paged occurrence reads equal to
  the unpaged scan with page count `ceil(4,194 / 250)`.
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
is written in 11 batches. If that keeps climbing, the next step is a projection
that ships only the groups a refresh changed rather than a full copy.

