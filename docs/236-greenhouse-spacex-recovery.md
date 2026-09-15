# #236 greenhouse-spacex recovery

Status: recovered on 2026-09-15. The classification fix shipped in
[#238](https://github.com/JDKrasnick/Ntern/pull/238) (merge `482a26a`,
deployed 15:12:40Z), one controlled recovery validation succeeded at
15:15:59Z, and the source is healthy and resumed. Its next scheduled poll is
subject to the greenhouse dispatch gate, which skips a run while the work queue
holds a backlog. D1 persistence instability remains with #203; if it recurs,
keep the source quarantined and hand the failure there rather than bypassing
quarantine.

## Determination

The 2026-09-15 failure was a transient board transfer, not parser drift and not
malformed upstream data.

- The board fetch relabelled every non-typed body failure as
  `Greenhouse returned malformed JSON`, and the `json` category quarantines on
  its first attempt (`shouldQuarantine` in `src/source-health.ts`). An aborted or
  short transfer therefore quarantined a board whose payload was intact.
- The eight-second deadline covered headers *and* the response body. Boards of
  this size transfer tens of megabytes, and this same board reached
  `temporary_provider_error` / `The operation was aborted due to timeout` twice
  in the preceding 24 hours.

## Captured provider sample

Read-only capture of the public endpoint on 2026-09-15T14:50:07Z
(`https://boards-api.greenhouse.io/v1/boards/spacex/jobs?content=true`):

| Measure | Value |
| --- | --- |
| Status / `content-length` | 200 / 27,727,834 bytes |
| `jobs` rows | 2,444 |
| Rows failing the adapter's row validator | 0 |
| Largest row | 37,115 bytes (row limit 512 KiB) |
| Eligible listings mapped | 40 |
| Apply-URL rejections | 0 |

Replaying the captured body through the checked-in adapter maps 40 eligible
listings with zero malformed rows, which matches the failing production run's
`listings: 40` / `rawRows: 2441`. The payload is well formed and inside every
board, row, and response-size guard, so neither schema drift nor upstream
corruption explains the quarantine.

## Production forensics

Source health (`catalog_items`, `SOURCE#greenhouse-spacex` / `HEALTH`) and the
worker event stream agree on this sequence:

| Time (UTC) | Outcome | Category | Diagnostic | Duration |
| --- | --- | --- | --- | --- |
| 2026-09-14T21:23:30Z | `temporary_provider_error` | `transport` | The operation was aborted due to timeout | 8,138 ms |
| 2026-09-15T04:14:59Z | `temporary_provider_error` | `transport` | The operation was aborted due to timeout | 8,272 ms |
| 2026-09-15T13:30:32Z | `invalid_schema` | `json` | greenhouse-spacex: Greenhouse returned malformed JSON | 12,328 ms |
| 2026-09-15T14:25:09Z | `catalog_write_failed` | `persistence` | D1_ERROR: internal error; reference = 6hi9i83lajvi9r65mtnuni1t | 147,334 ms |

The 13:30 UTC attempt is the quarantine: the same transient abort that produced
`transport` twice, raised while the body was being consumed, and relabelled as
schema drift. The checkpoint still holds 2,441 active ids from the last good
snapshot at 12:28:53Z.

The 14:22:42Z controlled recovery (actor `codex-production-recovery`) fetched
valid JSON and failed while persisting: 147,758 ms wall time against 7,494 ms
CPU. That error is not in `resilient-d1`'s retryable set
(`no longer active|Connection closed|reset because the connection|D1 DB reset|
Network connection lost|storage caused object to be reset`) nor in the queue
overload classifier, and the poller's per-source catch recorded the failure
health and returned, so the queue message was acknowledged rather than retried.
D1 stability remains #203's scope; this document only records that the recovery
validation is the path that must be retried once D1 recovery is decided.

## Fix

`src/sources/greenhouse.ts` now classifies board failures by what actually
arrived:

- an unparseable **complete** body stays `json`, which still quarantines;
- a failed body read, or a transfer that ends short of its declared
  `content-length`, is `transport`, which degrades and backs off;
- a rejected `fetch` is typed `transport` through `categorizeFetchError`.

The single deadline now matches the fifteen seconds the same endpoint already
gets from the candidate probe and the live contract check
(`GREENHOUSE_REQUEST_TIMEOUT_MS`).

Regression coverage: `test/greenhouse.test.ts` (mid-body abort, short transfer,
complete-but-invalid body) and `test/integration.workflow.test.ts` (a cut-off
transfer leaves the source `degraded`/`transport`, not quarantined). Against the
previous adapter all three fail with `json`, and the poll-level one quarantines.

## Recovery record

The supported flow ran on 2026-09-15 against the deployed fix:

| Step | Result |
| --- | --- |
| `recover` requested 15:15:31.923Z (`recovery-64282ef1-905d-40c7-b5d3-36fc1b1fe49b`) | `202`, `sourceStatus: paused`, `state: quarantined` |
| Validation poll 15:15:43.905Z → 15:15:59.073Z | `success_changed`, 2,444 raw rows, 40 eligible listings, 21,981 ms fetch span |
| Health after validation | `state: healthy`, `consecutiveFailures: 0`, `sourceStatus: paused` |
| `resume` at 15:16:19.478Z | `state: healthy`, `sourceStatus: active`, `incidentState: resolved` |
| Public API | `GET /jobs` 200 with the same 25 job ids; `GET /catalog?disciplines=Software%20Engineering` byte-identical to the pre-recovery capture; `GET /me/applications` and `GET /operations/sources` still 401 |

The same persisted diagnostic strings in this document come from
`catalog_items` (`SOURCE#greenhouse-spacex` / `HEALTH`) and the ingestion
Worker event stream, so a future recurrence can be diffed against them.
