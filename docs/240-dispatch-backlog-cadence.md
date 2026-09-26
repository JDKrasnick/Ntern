# #240 scheduled dispatch cadence under a queue backlog

Status: deployed and demonstrated in production on 2026-09-16. The queue-depth
gate is gone, dispatch is per-source, the cadence bound and its alarm are live,
the consumers are sized from the drain measurement, and both operator surfaces
report one backlog number. The demonstration below shows all 163 published
greenhouse sources, all 4 lever sources, and all 33 ashby sources polling inside
their interval across three post-deploy cycles; the remaining github delivery
defect is named at the end of that section.

## Determination

The 45+ minute gap was **throughput-bound, not paused and not
retained-by-failure**. Two mechanisms compounded:

1. **Arrivals exceeded drain.** Each half-hour sweep enqueued one message per due
   published board (`isProviderSourceDue` returns `true` for every published
   source on every run — `src/source-poll-cadence.ts`). Greenhouse alone
   dispatched 154-218 messages per sweep while its consumer was pinned to
   `batch_size: 1, max_concurrency: 2` with a measured per-message wall clock of
   ~23 s, so a sweep needed longer than the cadence to retire.
2. **A non-empty queue silenced the whole provider.** `queueHasBacklog` returned
   `true` for any `backlogCount > 0`, and the scheduled handler returned early
   for that provider — every published source of that provider, not only the
   sources already in the backlog. The gate logged `scheduled_dispatch_skipped`
   and nothing else: no counter, no age, no alarm.

The combination is self-reinforcing: a sweep that cannot finish before the next
cron suppresses the next sweep entirely, which is how `greenhouse-spacex` came
to have a 104-minute gap between attempts while the queue held a flat backlog.

## Evidence

Read-only production queries on 2026-09-15. Queue ids are the `*_QUEUE_ID` vars
in `wrangler.ingestion.jsonc`; the account is `4d67a0f1b73641df84af0a283dd5b3d8`.

### Deployed consumer settings (`/queues/{id}/consumers`)

| Queue | batch_size | max_concurrency | max_retries | max_wait_time_ms | retry_delay |
| --- | --- | --- | --- | --- | --- |
| greenhouse | 1 | 2 | 2 | 5000 | 0 |
| lever | 1 | 1 | 2 | 5000 | 0 |
| ashby | 1 | 1 | 2 | 5000 | 0 |
| github | 1 | 2 | 2 | 5000 | 0 |

These match `infra/cloudflare/main.tf` exactly, so the incident was not caused by
dashboard drift. The consumer was limited, not paused: `queueConsumerMetrics`
shows greenhouse concurrency averaging 1.32 and peaking at 2 across the window,
and both a work queue and its DLQ kept receiving traffic.

### Sweep arrivals and drain, 14:00-18:06Z

`queueMessageOperationsAdaptiveGroups`, messages written per sweep minute:

| Provider | 14:12 | 14:42 | 15:12 | 15:42 | 16:12 | 16:42 | 17:12 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| greenhouse | 173 | 192 | 154 | **0** | **0** | 218 | 198 |

Lever wrote 3-24 per sweep on `22,52`, ashby 24-108 on `2,32`, and github wrote
only 6 at 14:27 and 6 at 15:17 despite a `7-57/10` cron.

The two zero-write greenhouse sweeps (15:42 and 16:12) are the gate firing: every
published greenhouse source was due at those minutes, so the only way a sweep can
produce no writes is the provider-wide early return.

Drain over the same four hours: 935 greenhouse messages written, 837 delivered —
a persistent deficit of ~11% even with two sweeps suppressed. While a sweep was
actually being retired the consumer sustained ~28 messages/minute (174 of the
173-message 14:12 sweep inside six minutes), but the delivery stream repeatedly
stalled for 10-12 minutes in the middle of a sweep (16:45-16:56 and 17:17-17:27
have no `ReadMessage` at all).

`wrangler tail` over the same hour shows a healthy individual message is cheap:
`wallTime` for a greenhouse consumer invocation is 1.0-9.4 s with a median near
3 s, and each invocation is one board (`batchSize: 1`). Two slots at 3 s each
could retire the 218-message sweep in ~7 minutes, so the median is not the
binding constraint — the 10-12 minute idle stretches are. Two causes are
plausible and both are addressed below: the platform's 15-minute consumer limit
lets a stalled fetch hold one of only two slots, and the provider-wide gate then
removes the next sweep instead of recovering the interval.

Sizing therefore uses the **effective** consumer time per message over the whole
window — Little's law, `concurrency x 60 / deliveriesPerMinute` =
`1.32 x 60 / 3.5` ≈ **23 s** — because that is the quantity that decides whether
a sweep retires inside its cadence. Sizing from the 3 s median alone would leave
the fleet one stalled fetch away from the same backlog.

### The gate firing, captured live

`npx wrangler tail intern-notifs-ingestion --format json --config wrangler.ingestion.jsonc`
on the deployed (pre-change) worker captured the gate in the act at 2026-09-15T18:18-18:32Z:

```json
{"event":"scheduled_dispatch_skipped","queue":"github","backlogCount":4}
{"event":"scheduled_dispatch_skipped","queue":"github","backlogCount":4}
```

Four queued messages withheld the dispatch of every published github source on
two consecutive `7-57/10` runs — the sharpest illustration of the defect: the
gate had no lower bound, so the smallest residual backlog silenced a whole
fleet, and the skip was reported only as a queue name and a count with no
mention of which sources went unpolled.

### Not retained by an earlier failed attempt

`queue_failure_events` for the window holds exactly two unresolved rows, both
github (`14:16:28Z`, `14:25:10Z`). Greenhouse had no ledgered failure between
14:00Z and 18:06Z; the only greenhouse dead-letter events in the window are one
message at 16:08Z and one at 17:51Z, against 935 writes. Messages were
undelivered because they were never consumed in time, not because a failed
attempt kept them invisible.

### Published-source counts and fetch durations

`reviewed_source_registry` (`state = 'active'` is the published status) versus
the operations surface at 18:06Z:

| Provider | Registry active | Ops published | Largest observed sweep | Fetch p50 / p90 (`durationMs`) |
| --- | --- | --- | --- | --- |
| greenhouse | 166 | 163 | 218 | 195 ms / 632 ms |
| lever | 4 | 4 | 24 | 217 ms / 1342 ms |
| ashby | 36 | 33 | 108 | 174 ms / 303 ms |
| github | — | 6 | 6 | 344 ms / 875 ms |

`durationMs` measures the fetch only, so it is a lower bound on the whole-message
cost; 206 published sources existed in total, and 125 of them had a
`lastAttemptAt` older than 45 minutes at 18:06Z.

### One number for one queue (criterion 4)

Metrics REST and the operations surface sampled within the same second at
2026-09-15T18:06:25Z:

| Provider | `/queues/{id}/metrics` `backlog_count` | ops `waiting` | ops `processing` | DLQ depth |
| --- | --- | --- | --- | --- |
| greenhouse | 0 | 0 | 0 | 105 |
| lever | 0 | 0 | 0 | 16 |
| ashby | 61 | 61 | 0 | 2 |
| github | 4 | 4 | 0 | 189 |

The two surfaces never disagreed when sampled together: both read the same
binding value through `queue.metrics()`. The earlier 82-versus-1 discrepancy came
from sampling minutes apart while a sweep was draining, and `processing` can only
ever be `0`/`null` because Cloudflare exposes one backlog total and no
visible-versus-in-flight split. The operations payload now carries
`backlogCount` and `oldestMessageTimestampMs` under Cloudflare's own field names
so the comparison needs no translation, and `waiting` is retained for the
existing dashboard at `monitoring.jdkrasnick.com`.

One reading from the issue could not be reproduced: the reported
`oldest_message_timestamp_ms` of `2026-09-15T16:02:15.922Z` for greenhouse does
not match any greenhouse write minute in 14:00-17:10Z (writes exist only at
`:12` and `:42`). Treat that single sample as unverified; every other number in
this document traces to a command below.

## The fix

### Dispatch no longer depends on queue depth

- `cloudflare/queue-backlog.ts` is deleted; neither the github branch nor the
  catalog-provider branch of `scheduledHandler` consults queue depth any more.
- `due()` returns `{ due, inFlightSkipped }` and consults a per-source marker:
  a source is suppressed only while **its own** work message is pending.
- `dispatchProviders` writes the marker after a successful `sendBatch` and emits
  `provider_dispatch_complete` with `candidates`, `queued`, and
  `inFlightSkipped` on every sweep, so suppression is now observable.
- Markers live in the existing `catalog_items` key-value table
  (`sk = 'DISPATCH'`, `kind = 'source-dispatch'`), so the write cannot clobber a
  concurrent consumer health update and no migration is needed.
- `force` replays (`/internal/backfill`, `/internal/poll-source`, recovery
  probes) bypass suppression entirely, exactly as they bypassed the old gate.

### The cadence bound is one lease

`SOURCE_DISPATCH_LEASE_MS` = `publishedIntervalMs` = 30 minutes. A marker expires
one cadence after it is written, so a message that is lost or dead-lettered
delays its source by at most one interval, and consecutive attempts are at most
two cadences apart. A consumer completion — success or failure — writes a newer
`lastAttemptAt` and clears the suppression sooner.

Observed in production at 2026-09-16T02:47:49Z, once github's messages stopped
being consumed: `{"provider":"github","candidates":6,"queued":0,"inFlightSkipped":6}`
— every source already had a pending message, so the sweep enqueued nothing
instead of stamping six duplicate messages every ten minutes as the previous
deploy did (`queued: 6, inFlightSkipped: 0` at 00:47:49Z).

### The alarm

`SOURCE_CADENCE_SLIP_MS` = two cadences. A published source that is not
quarantined, not paused, and not inside a `backoffUntil` window and whose
`lastAttemptAt` is older than two cadences raises:

- `provider_cadence_slip`, a structured log line with the count and up to 20
  source ids, emitted from the same cron run that dispatched the provider; and
- the `"<provider>-cadence-slip"` signal through `sendAdmissionOperationalAlert`,
  deduplicated per day and signal set, so the mailbox sees at most one message
  per provider per day.
- Shadow sources are exempt (`shadowIntervalMs` is three hours), and the
  operations payload reports `productionMetrics.overduePublishedSources`.

Deviation from the approved plan: a published source with **no health row** is no
longer counted as overdue. The provider cron dispatches a newly published source
in the same run that evaluates the alarm, so its first attempt cannot have
completed yet and the plan's rule would have raised a cadence alert for every new
source before it was ever polled — one extra deduplicated email per provider per
day for a condition that is not a cadence slip. Never-polled sources are still
reported, as `state: 'never-succeeded'` and inside
`productionMetrics.staleSources`.

### Throughput is sized from the drain measurement

`max_concurrency = min(10, max(2, 2 x ceil(sweep x wallClock / cadence)))`, with
the factor of two covering the validation, notification, and D1 work that the
recorded fetch duration does not measure:

| Provider | Sweep | Per-message wall clock | Ceiling | `max_concurrency` |
| --- | --- | --- | --- | --- |
| greenhouse | 218 | 23 s (Little's law) | 3 | **6** (was 2) |
| lever | 24 | 31 s (Little's law) | 1 | **2** (was 1) |
| ashby | 108 | 8 s (Little's law) | 1 | **2** (was 1) |
| github | 6 | 875 ms (p90) | 1 | **2** (unchanged) |
| gmail / destination-verification / shadow-extraction | — | — | — | 1 (unchanged) |

At greenhouse's new concurrency, one 218-message sweep retires in roughly
`218 x 23 / 6` ≈ 14 minutes of consumer time, inside the half-hour cadence with
room for the p90 tail. The values live in `locals.consumer_max_concurrency` in
`infra/cloudflare/main.tf` and are mirrored in `wrangler.ingestion.jsonc`; a
config test fails if the two ever disagree.

### No single message can hold a slot for minutes

- Ashby and Lever shadow retries now throw instead of sleeping when a provider
  `Retry-After` exceeds `SOURCE_RETRY_DELAY_CAP_MS` (60 s), the same cap the
  shared poller already applied (`src/poll.ts`). The message then fails into the
  durable `backoffUntil` and the queue retry path rather than parking a consumer.
- Lever page fetches carry `AbortSignal.timeout(LEVER_REQUEST_TIMEOUT_MS)` (15 s)
  like the Greenhouse and Ashby adapters.
- Every work message runs under `SOURCE_MESSAGE_DEADLINE_MS` (5 minutes), applied
  per record in `processFifoBatch` and per message in the github consumer
  (both via `withinMessageDeadline`). Exceeding it raises
  `QueueMessageDeadlineError: message deadline: the operation timed out after
  300000 ms`, which
  the existing per-record failure path turns into a health failure, a
  `queue_failure_events` row, and a queue retry — the consumer slot is released
  immediately instead of being held until the platform's 15-minute limit.
  Five minutes is more than twice the longest legitimate attempt on record (a
  27 MB board whose D1 write took 147 s) and one sixth of the cadence.
- The error text is deliberately a timeout (`... the operation timed out ...`),
  which `sourceFailureCategory` maps to `transport`. The first wording said
  "exceeded", which maps to `capacity`, and two `capacity` failures quarantine a
  source (`shouldQuarantine`) — a stalled invocation must never quarantine.
- `resilientD1` now bounds **each** D1 attempt with `attemptTimeoutMs`
  (20 s default) and classifies a statement that outlives it as
  `D1StatementStallError` → its own `stalled` class, which is retryable
  in-request. That is the layer that actually fixes a stalled read: a request that
  never settles produces no error, so neither the reconnect retry nor the
  queue-boundary pacing could ever see it. Worst case is now
  `5 x 20 s + backoff ≈ 101 s`, comfortably inside the 5-minute message deadline,
  so the retry chain always finishes and the health write still lands.
- Destination-verification handoffs from the consumers go through
  `sendQueueMessageWithin` (5 s) instead of a bare `queue.send`.
- `dnsJson` — the DoH resolver shared by structured (github) sources, employer
  challenge verification, and reviewed-host validation — carries
  `AbortSignal.timeout(DOH_QUERY_TIMEOUT_MS)` (8 s). It was the only unbounded
  await left in the github consumer path; a stalled resolver query used to park
  the invocation. A timeout now fails the probe as
  `DNS verification timed out for <name> (<type>)`.

#### Why the deadline exists: one message blocked a whole sweep

At 2026-09-16T02:12:53Z a greenhouse sweep wrote 172 messages and delivered
essentially all of them in four minutes (concurrency 6: `ReadMessage` 7 + 109 +
59 + 2 with matching deletes, 02:12-02:15). One message did not arrive until
02:29-02:30 — 17 minutes later — and during that wait
`queueConsumerMetricsAdaptiveGroups` reported `avg.concurrency` of exactly 6 for
every minute from 02:14 to 02:29 with **zero** reads, then decayed to 0.58 and 0
once the message was finally consumed. Six consumer invocations were therefore
alive and holding slots while a queued message waited; two healthy published
sources (`greenhouse-andurilindustries`, `greenhouse-stripe`) missed that
interval. The deadline bounds exactly this: whatever the hung collaborator is,
the invocation now returns, the slot frees, and the message is retried.

#### What the deadline did in production

Deployed at 2026-09-16T02:43Z. Failures recorded in `queue_failure_events` with
`diagnostic = 'message deadline: the operation timed out after 300000 ms'`, 02:40-03:19Z:

| Queue | Source | Events | Still open |
| --- | --- | --- | --- |
| github | `simplify-summer-2026` | 3 | 3 |
| github | `speedyapply-2027-swe` | 3 | 3 |
| github | `speedyapply-2027-ai` | 2 | 2 |
| github | `canadian-tech-2027` | 2 | **0** |
| greenhouse | `greenhouse-rocketlab` | 1 | 1 |

- `canadian-tech-2027` is the intended behaviour end to end: two attempts hung,
  each was failed at five minutes, and the retry **completed** — the source moved
  from stuck-since-2026-09-15T14:15Z to a fresh `lastAttemptAt`. `vanshb03-summer-2027`
  and `northwestern-fintech-2027-quant` also advanced for the first time that day.
- `greenhouse-rocketlab` is the only catalog-provider hang in that window, one
  message in roughly 650. The slowest legitimate greenhouse attempt on record is
  3,982 ms (`greenhouse-andurilindustries`, 2,318 rows), so a five-minute deadline
  is 75x the worst real work and cannot be cutting a healthy poll.
- Github's two aggregator boards hang on every attempt, so their deadline
  failures repeat and stay open. Whether that work is legitimately longer than
  five minutes (bounded per delivery by `GITHUB_RESOLUTION_ROWS_PER_DELIVERY`) or
  hung is github-scope work; the catalog providers — the fleets this issue is
  about — never tripped the deadline except that single `greenhouse-rocketlab`
  message.

#### The one catalog-provider hang is a stalled pre-fetch read

`greenhouse-rocketlab` hit the deadline on **all three** attempts (03:18:55,
03:23:56, 03:28:57 — 300 s apart), while its last good poll took 733 ms of
recorded fetch and 13.4 s of `SourceFetchDurationMs` for 510 rows. So the hung
work is neither its normal cost nor a big-board tail. The decisive detail is what
it did *not* log: a hung attempt emits nothing at all, not even
`source_fetch_completed`, and every greenhouse fetch carries a timeout
(`greenhouse.ts:108` 8 s, `:131` 15 s, `:331` `GREENHOUSE_REQUEST_TIMEOUT_MS`), as
does the link validator (8 s request + 8 s body deadline) and the Expo publisher.
The awaits that precede that first log line are the D1 reads the poll begins with
(`getSourceHealth`, `getCheckpoint`). A *stalled* D1 request never throws, so
before this change neither the reconnect retry nor the queue-boundary pacing
could see it: it parked the invocation until the per-message deadline fired five
minutes later.

That is why the fix sits one layer down. `resilientD1` bounds each attempt at 20 s
and retries a stall as a transient failure (see "No single message can hold a slot
for minutes"), so a stalled read now fails the message in ~20 s, the retry chain
finishes inside the record deadline, and the health write still lands. The record
deadline remains the outer backstop for a stall outside a D1 call.

#### Two boards fail the response-body guard every attempt

Two greenhouse boards fail every attempt on the **16 MiB response-body guard**
(`Greenhouse response body exceeds 16777216 bytes`, category `persistence`):
`greenhouse-spacex` (27.7 MB board, currently quarantined) and
`greenhouse-andurilindustries`. That guard is a resource-bound decision from
another workstream, not dispatch cadence: the sweep reaches them, the message is
processed, the poll fails, and it retries — the dispatcher is not the constraint.
The cadence alarm stays quiet for them because each failed attempt still writes
`lastAttemptAt`; their condition surfaces in `productionMetrics.staleSources`
instead.

## Operator procedure: one backlog number per queue

Sample both surfaces within the same minute; they are live values, not windows.

```bash
set -a; . ./.env; set +a

# Operations surface (what the dashboard renders)
curl -fsS -H "X-Operations-Key: $OPERATIONS_SHARED_SECRET" \
  https://intern-notifs.jdkrasnick.workers.dev/operations/sources \
  | jq '{fleets: [.fleets[] | {provider, queue}],
         overdue: .productionMetrics.overduePublishedSources}'

# Cloudflare's own metrics for the same queue
curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues/$GREENHOUSE_QUEUE_ID/metrics"
```

`fleet.queue.backlogCount` must equal `backlog_count` for the same queue, and
`fleet.queue.oldestMessageTimestampMs` must equal `oldest_message_timestamp_ms`
(or be `null` when the work-queue aggregate has no oldest message). `waiting` is
the identical number under the legacy AWS name.

Reading rule, unchanged from `docs/dlq-reconciliation-runbook.md`: a non-zero
work queue is not a failure by itself. Treat an unchanged or growing depth across
two cadences, without corresponding successful runs, as an incident — and now
also check `provider_cadence_slip` and
`productionMetrics.overduePublishedSources`, which name the sources that missed
an interval instead of leaving it to be inferred from queue age.

## Demonstration record (criterion 5)

### Deployment

`npm run build:cloudflare` (both bundles rebuilt; the ingestion bundle contains
`provider_dispatch_complete` and `source-dispatch`) then
`tofu -chdir=infra/cloudflare plan` and `apply`: 0 to add, 5 to change, 0 to
destroy — the three catalog consumers plus the two worker bundles. The plan
changed exactly `max_concurrency = 1 -> 2` (lever), `2 -> 6` (greenhouse), and
`1 -> 2` (ashby); no queue or DLQ setting changed otherwise.

Verified against `/accounts/{account_id}/queues/{queue_id}/consumers` at
2026-09-16T00:44Z:

| Queue | batch_size | max_concurrency | max_retries | max_wait_time_ms |
| --- | --- | --- | --- | --- |
| greenhouse | 1 | 6 | 2 | 5000 |
| lever | 1 | 2 | 2 | 5000 |
| ashby | 1 | 2 | 2 | 5000 |
| github | 1 | 2 | 2 | 5000 |

### Snapshot A (2026-09-16T00:46Z)

One published healthy source per provider was paused and resumed immediately
before the snapshot, so each provider's next cron (greenhouse `12,42`, lever
`22,52`, ashby `2,32`) has a resumed source to poll:

| Provider | Source | Resumed at |
| --- | --- | --- |
| greenhouse | `greenhouse-figma` | 2026-09-16T00:46:03Z |
| lever | `lever-palantir` | 2026-09-16T00:46:03Z |
| ashby | `ashby-etched` | 2026-09-16T00:46:12Z |

Depths at snapshot A, sampled within one second of each other:

| Provider | work `backlog_count` | ops `waiting`/`backlogCount` | ops `oldestMessageTimestampMs` | DLQ depth |
| --- | --- | --- | --- | --- |
| greenhouse | 33 | 30 / 30 | 1789519373488 | 76 |
| lever | 0 | 0 / 0 | null | 6 |
| ashby | 0 | 0 / 0 | null | 2 |
| github | 2 | 2 / 2 | 1789516070574 | 190 |

The ops `oldestMessageTimestampMs` equals the metrics
`oldest_message_timestamp_ms` for both non-empty queues, which is criterion 4's
per-field proof that the two surfaces report the same quantities.

### Snapshot B and the interval table

Snapshot B at 2026-09-16T02:20Z, after each provider's cron windows that follow
snapshot A (greenhouse `12,42` ×3, lever `22,52` ×2, ashby `2,32` ×3).

Resumed sources:

| Provider | Source | Resumed | First attempt after resume | Minutes to first attempt | Attempts since resume | State |
| --- | --- | --- | --- | --- | --- | --- |
| greenhouse | `greenhouse-figma` | 00:45:54Z | 01:13:32Z | 27.6 | 3 | healthy |
| lever | `lever-palantir` | 00:46:03Z | 00:53:12Z | 7.2 | 3 | healthy |
| ashby | `ashby-etched` | 00:46:12Z | 01:03:08Z | 16.9 | 3 | healthy |

Every resumed published source polled inside its interval, on the first cron after
its resume, and kept polling.

Interval table for 00:46-02:20Z, from each source's recorded `recentRuns`
(`catalog_items`, `sk = 'HEALTH'`):

| Provider | Published sources | Attempted in window | Never attempted | Max consecutive gap | Gaps above one cadence |
| --- | --- | --- | --- | --- | --- |
| greenhouse | 163 | 163 | 0 | 1,858,938 ms (31.0 min) | 0 |
| lever | 4 | 4 | 0 | 1,804,210 ms (30.1 min) | 0 |
| ashby | 33 | 33 | 0 | 1,800,546 ms (30.0 min) | 0 |
| github | 6 | 3 | 3 | 3,615,985 ms (60.3 min) | 2 |

Greenhouse, lever, and ashby — the providers this criterion names — polled every
published source with no gap above one cadence plus five minutes. Greenhouse's
31.0-minute worst case is the `12,42` sweep pattern plus queue wait.

Github is a separate, pre-existing defect, recorded rather than hidden:
`simplify-summer-2026` has not attempted since 2026-09-09, and
`speedyapply-2027-swe` / `speedyapply-2027-ai` last attempted around
2026-09-15T12:38-14:25Z. Its messages are consumed and dead-lettered
(`intern-notifs-github-dlq` holds 190) instead of delivered, which is exactly what
the new alarm reports: the 00:47:49Z github run emitted `provider_cadence_slip`
with `count: 4` naming those sources, and `productionMetrics.overduePublishedSources`
reads `3` at snapshot B. That is github source/destination work, not dispatch
cadence — the same run still dispatched all six candidates (`queued: 6`,
`inFlightSkipped: 0`) where the old gate would have dispatched none.

Depths before (snapshot A) and after (snapshot B):

| Queue | Work backlog A → B | DLQ A → B |
| --- | --- | --- |
| greenhouse | 33 → 1 | 76 → 76 |
| lever | 0 → 0 | 6 → 6 |
| ashby | 0 → 0 | 2 → 2 |
| github | 2 → 13 | 190 → 190 |
| all fleets (`productionMetrics`) | `queuedMessages` 35 → 7 | `deadLetterMessages` 583 → 274 |

Greenhouse's backlog fell 97% while every one of its published sources was polled
twice or more: the queue drained *because* dispatch stopped waiting for it.

Field-level reconciliation at snapshot A was exact: ops `oldestMessageTimestampMs`
`1789519373488` and `1789516070574` equal the metrics `oldest_message_timestamp_ms`
for greenhouse and github, and ops `waiting` equals `backlog_count` for all four
fleets (`0/0`, `0/0`, `2/2`), matching the earlier synchronized sample at
18:06:25Z where all four pairs agreed. Sample both surfaces within the same minute:
during active drain the two calls are seconds apart and legitimately differ by the
messages retired in between (greenhouse read `33` and `30` one second apart while
draining).

## Remaining operational steps

1. Github source delivery: root-caused and fixed on 2026-09-26. The bounded
   resolution pass selected its slice in board order, so a run of rows whose
   application-link probes keep timing out was re-attempted on every delivery
   and the rest of `pendingResolutionRows` was never reached.
   `simplify-summer-2026` froze at 3,198 pending rows and re-enqueued a
   continuation on every poll, which held the github work queue near 542 and let
   resource-killed deliveries dead-letter without a failure-ledger row. The slice
   now follows the pending pass order, so it resumes where the last delivery
   stopped and advances past a retryable prefix; once only probes remain the
   dispatcher retries them without a hot queue loop. A pass that still cannot
   shrink its pending set no longer re-enqueues itself either: it falls back to
   the dispatcher cadence and records one scoped `github_resolution_stalled`
   event so the non-shrinking cause stays diagnosable. Expect
   `github-cadence-slip` and the `dlq-growth` github signal to clear as the
   backlog drains.
2. Watch the new signal rather than queue depth. `provider_dispatch_complete`
   reports `candidates`, `queued`, and `inFlightSkipped` on every sweep, so a
   fleet that stops dispatching is visible in one line, and
   `provider_cadence_slip` names the sources that missed an interval:
   `npx wrangler tail intern-notifs-ingestion --format json --config wrangler.ingestion.jsonc --search provider_cadence_slip`.
3. Re-derive the consumer concurrency if the fleet grows. The values in
   `locals.consumer_max_concurrency` follow
   `min(10, max(2, 2 x ceil(published x wallClock / cadence)))`; re-measure with
   the consumers and metrics endpoints under "Operator procedure" and update both
   `infra/cloudflare/main.tf` and `wrangler.ingestion.jsonc` together (the config
   test fails if they diverge).
