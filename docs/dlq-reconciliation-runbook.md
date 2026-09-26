# DLQ reconciliation runbook

Use this runbook to reconcile a non-empty provider dead-letter queue without
turning inspection into a replay or a purge. It applies to the Greenhouse,
Lever, Ashby, and GitHub catalog queues. The `greenhouse-haizelabs` quarantine
is an example of a source that remains paused until its source-specific defect
has current evidence and a successful recovery validation.

## 1. Record a read-only baseline

Before any source action, record the timestamp and the `GET /operations/sources`
response. For every provider, retain work queue depth, DLQ depth, provider
availability, and the source-health records for degraded and paused sources.

Queue work is making forward progress when a second snapshot after a full
provider cadence shows either a lower work depth or a newer trusted source run.
A non-zero work queue is not a failure by itself: it can be scheduled work that
is waiting for a consumer. Treat an unchanged or growing depth across two
cadences, without corresponding successful runs, as an incident.

Do not use this step to resume a paused source or alter a queue.

## 2. Inspect, then classify the sample

Use only the protected non-consuming endpoint or CLI inspection. Inspect each
queue separately and retain its full sanitized response outside the repository.

```bash
npm run dlq -- inspect greenhouse 100
npm run dlq -- inspect lever 100
npm run dlq -- inspect ashby 100
npm run dlq -- inspect github 100
```

For catalog queues, every returned message has `failureProvenance`:

| Value | Meaning | Operator response |
| --- | --- | --- |
| `ledgered` | The queue-failure ledger contains a category and diagnostic for this exact message. | Use the category with current source health to decide whether a source-specific correction is needed. |
| `missing-ledger` | No matching queue-failure event is retained. The message is unclassified; it is not proof of a transient failure. | Keep it in the DLQ and record it as historical or otherwise unclassified until current evidence supports a narrow action. |
| `not-applicable` | The queue does not use the catalog failure ledger. | Follow that queue's dedicated recovery procedure. |

`classificationCounts` summarizes only the inspected sample. It must never be
presented as a count of the entire backlog. Re-run inspection after any source
recovery and preserve the before/after samples with their timestamps.

## 3. Recover sources one at a time

For each degraded GitHub source, inspect current source health and its latest
safe diagnostic. Classify it as one of:

- transient only when a current forced validation succeeds;
- stale by policy when its last trusted success is outside the GitHub freshness
  objective and the source has no current parser or upstream error;
- source-specific correction when the diagnostic identifies a repository,
  schema, or upstream contract defect.

Use `recover` for a quarantined source, verify the resulting validation, then
use `resume` only after health returns to healthy. Do not recover or resume an
intentionally quarantined source merely to reduce the backlog. For an active
source with current valid evidence, use a single source replay and wait for the
result before handling the next source.

## 4. Stage, review, then apply a DLQ plan

Only after source recovery has a documented successful result may an operator
stage a selected replay or discard plan. Plans must name exact inspected message
IDs, include a reason tied to the current evidence, and have an independently
reviewed expected count. Do not create a plan for every message in a queue.

```bash
DLQ_ACTION=replay npm run dlq -- plan github message-id-1,message-id-2 'Current source validation succeeded; replay reviewed historical messages'
npm run dlq -- apply PLAN_ID REPAIR_TOKEN 2
```

The repair token is one-use and expires after 15 minutes. A catalog replay sends
one fresh poll per selected source and purges only the exact successfully
replayed DLQ messages. A plan rejects paused or quarantined sources and rechecks
selection drift before applying.

## 5. Verify and record residuals

After each approved action, take a new `/operations/sources` snapshot and
non-consuming DLQ sample. Require provider availability, public `/jobs`, and
notification behavior to remain healthy. Record all remaining queue/DLQ depths,
`missing-ledger` sample count, intentionally paused sources, and any unresolved
source-specific defect in the operations dashboard or incident record.

An unexplained historical backlog is an expected residual only when it remains
untouched, is explicitly counted, and has a follow-up owner. It is never a
reason to bulk replay or purge.

## 6. Reconciliation record: 2026-09-16

Classified with `inspect` (100-message non-consuming peek) for all four catalog
queues after the dispatch fixes landed (#240). Counts are *visible* messages, not
depth.

| Queue | Visible | `missing-ledger` | Source active + healthy | Source paused/quarantined | DLQ depth |
| --- | --- | --- | --- | --- | --- |
| github | 35 | 35 | 35 | 0 | 195 |
| greenhouse | 12 | 12 | 8 | 4 (`greenhouse-andurilindustries` ×3, `greenhouse-iherb`) | 75 |
| lever | 6 | 6 | 6 | 0 | 6 |
| ashby | 2 | 2 | 0 | 2 (`ashby-odin-dynamics`) | 2 |

Every visible catalog message is `missing-ledger`: its payload predates the
per-message failure ledger (timestamps 2026-09-11 to 2026-09-15), so the original
category cannot be reconstructed. That is the expected result for a historical
backlog, not evidence of a current defect.

**Applied (owner-approved, 2026-09-16):** the obsolete messages were discarded
rather than replayed — each belongs to a source that has polled successfully
since the message was dead-lettered, so a catalog replay would only send a
duplicate poll. Every disposition is audited in `dlq_disposition_audit`:

| Queue | Action | Messages | Applied | Plan |
| --- | --- | --- | --- | --- |
| lever | discard | 6 | 05:18:47Z | `bc411063-e454-4dc2-adb5-55c5829ca05e` |
| greenhouse | discard | 4 | 05:38:45Z | `a893b6b9-c555-4ea7-80ba-aac2b52c29bb` |

**Residual, counted and retained:** greenhouse 74, github 196, ashby 2 (both
ashby messages belong to a paused source and were intentionally kept). Failed
plans stay unapplied and write no audit row, so a drift error can never purge a
partial selection.

**Why the drain stopped at ten.** A non-consuming peek returns only the messages
that are currently available, not the queue depth: against depths of 75
(greenhouse) and 196 (github), peeks returned 1-35 messages and the window
rotated between calls. `plan` and `apply` each re-peek and validate the selection
by message id and payload hash, so a selection larger than the current window
fails with `Selection drift`, and on github even a single-message selection
drifted because the window changed between the inspect and the plan — concurrent
operator peeks (there are unapplied github replay plans from an earlier session)
make that window move faster. Practical guidance:

- Select only ids returned by the peek you are about to plan from, keep the
  selection small, and expect to iterate: draining a deep DLQ takes many cycles
  across sessions, not one plan.
- Expect to wait between cycles; a peek leases what it returns, so the population
  it will hand you next is smaller and different.
- If a full drain is ever required, the missing capability is server-side
  selection (stage the plan from the plan's own peek) rather than client-supplied
  ids. Until then, a large historical backlog is an expected residual.

Two measurement caveats learned here:

- **Depth is not the peek count.** A non-consuming peek leases what it reads, so
  the messages it returns stay invisible to the next peek for the lease duration.
  `github` reports depth 195 while a single peek returns 35; `lever` and `ashby`
  reconcile exactly (6/6, 2/2) because their populations are small enough to be
  fully returned each time. Wait for the lease to lapse before comparing, and
  never plan against a selection built from an older peek — `plan` re-peeks and
  rejects selection drift for exactly this reason.
- **DLQ depth has no REST metrics surface.** `/queues/{queue_id}/metrics` returns
  `Invalid queueID` for a dead-letter queue; only the operations surface (the
  worker binding) reports DLQ depth. Use `fleet.queue.deadLettered` for depth and
  `inspect` for population.

### Degraded GitHub sources: cause and fix

All six published GitHub sources showed `state: degraded` on the operations
surface while storing `state: healthy` with a successful run. The stored `state`
was healthy, so the surface derived `degraded` from
`integrationRegistry.github.freshnessWindowMs` (30 minutes).

The reason their successes were ~31-33 minutes apart, despite a ten-minute cron,
was the dispatch lease. The GitHub consumer ledgered a failure but never wrote
source health, so `lastAttemptAt` stayed at the last *success*: the marker
written at dispatch kept that source suppressed for a whole lease (30 minutes)
even though its message had already failed. Recording the failed attempt (this
PR) releases the lease, resets the interval, and makes `state`, `outcome`,
`consecutiveFailures`, and the alert surface describe the source truthfully.
Structured sources already did this; only the default list sources did not.

**The window itself is correct and was left unchanged.** Every fleet sets three
sweep cadences — 90 minutes for the half-hourly crons, 30 minutes for GitHub's
ten-minute cron — so it tolerates exactly two missed sweeps. Measured after the
lease fix (successful-run intervals from `recentRuns`, 2026-09-16):

| Source | p50 interval | worst of the last 8 | all-time max |
| --- | --- | --- | --- |
| `simplify-summer-2026` | 0.5 min | 0.7 min | 1.2 min |
| `speedyapply-2027-ai` | 0.5 min | 0.9 min | 1.1 min |
| `vanshb03-summer-2027` | 0.6 min | 0.9 min | 10.0 min |
| `speedyapply-2027-swe` | 0.5 min | 1.4 min | 10.1 min |
| `canadian-tech-2027` | 0.8 min | 3.0 min | 46.7 min |
| `northwestern-fintech-2027-quant` | 16.7 min | 10.5 min | 128.9 min |

The sub-minute pairs are retried deliveries of the same source; the 10-minute
figures are the cron cadence. The all-time maxima (46.7 and 128.9 minutes) are
pre-fix stalls. A source now has to miss two full sweeps to be reported
degraded, which is the intended signal — widening the window would hide it.

## 7. Reconciliation record: 2026-09-25

Applied after #398 made every source-scoped catalog failure defer to the
provider dispatcher and ack on its final delivery, so the catalog DLQs hold
poison only. The residual below predates that change and is superseded work:
every source has been re-dispatched since its message was dead-lettered, so a
catalog replay would only send a duplicate poll.

| Queue | Action | Messages | Plan |
| --- | --- | ---: | --- |
| github | discard | 191 | `822b686e-7856-4d47-ab39-4dc12ba32c92` |
| greenhouse | discard | 128 | `6e7fbdcc-93be-4d5c-bba5-34759e134c69` |
| lever | discard | 6 | `db117068-8d07-4b17-a7ad-dca7273f8a09` |
| ashby | discard | 26 | `ae814d02-66e5-4e0a-9009-29dc5feaa56e` |

Destination verification is the opposite case: nothing re-inspects an admitted
destination after the 2026-09-17 durable-admission decision, so an acked message
drops work rather than deferring it. The classified backlog was 89% `daily-retry`
— scheduled re-checks that decision removed — so the admission-relevant reasons
(`content-change`, `historical-backfill`) were replayed and the vestigial
scheduled ones discarded.

| Queue | Action | Messages | Plan |
| --- | --- | ---: | --- |
| destination-verification | replay | 76 | `5c469321-a5a4-4f8f-9837-429495d9ed94` |
| destination-verification | discard | 513 | `4f7069ed-edfd-4176-b818-907f4668a0f2` |

The four catalog DLQs and the destination-verification DLQ read 0 after the
disposition; the gmail DLQ is untouched at 1. Every disposed message is recorded
in `dlq_disposition_audit`. The protected `POST /internal/operations/dlq` endpoint
was unusable for this pass — the operator key did not match the deployed
`OPERATIONS_SHARED_SECRET` — so the same peek → send/purge → audit sequence ran
directly against the Cloudflare queue API and the audit rows were written to D1.
Reconcile the operator key before the next reconciliation so the guarded plan
and one-use token flow is available again.

## 8. Failure-ledger resolution (2026-09-25)

`queue_failure_events.resolved_at` is the pending flag: an unresolved row is a
per-message failure no later delivery or disposition has cleared. It is not a
queue depth and it is not the DLQ backlog. As of 2026-09-25 the table held 462
unresolved rows (github 226, greenhouse 111, destination-verification 62,
ashby 39, lever 24). Most are historical residue: rows written before the
resolution paths existed, or messages that dead-lettered and were later disposed,
whose messages are no longer anywhere. The DLQs themselves read 0-1.

Two holes produced rows that will never clear on their own, and both now resolve:

- **Destination verification recorded but never resolved.** The consumer's
  per-message catch ledgered a failure and retried, but a later delivery that
  settled or found the work already complete acked without clearing the row. It
  had 0 resolved rows against 62 pending, growing at the transient browser
  failure rate. It now resolves the row before every ack, guarded to retried
  deliveries (`attempts > 1`) so a first delivery writes nothing extra.
- **A DLQ disposition left the ledger pending.** `apply` recorded the audit row
  and purged the message but never touched its `queue_failure_events` row, so a
  reconciled DLQ kept its failures in the unresolved signal until the 30-day
  cleanup. `apply` now resolves the row with the disposition.

The existing residue is left untouched. It is not a live defect and it ages out
at the 30-day cleanup (`cleanupDlqRecords`), so the unresolved count is bounded
by the trailing 30 days of failures that are still pending. Treat a *growing*
unresolved count for a queue, not a large absolute one, as the signal: with the
two holes closed, growth means either a source that is genuinely still failing
or a message still sitting in a DLQ.
