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

**Nothing was replayed or discarded.** Each of the 49 messages whose source is
active and healthy belongs to a source that has polled successfully since the
message was dead-lettered, so a catalog replay would send one fresh poll per
source and purge the messages — duplicate work for no new evidence. The 6
remaining messages belong to sources that are intentionally paused or
quarantined; `plan` rejects catalog replay for those, and the standing instruction
is not to bulk purge this backlog. The residual stays counted and owned by #219.

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
`integrationRegistry.github.freshnessWindowMs` (30 minutes), which equals the
published interval: any normal jitter crossed it.

The reason their successes were ~31-33 minutes apart, despite a ten-minute cron,
was the dispatch lease. The GitHub consumer ledgered a failure but never wrote
source health, so `lastAttemptAt` stayed at the last *success*: the marker
written at dispatch kept that source suppressed for a whole lease (30 minutes)
even though its message had already failed. Recording the failed attempt (this
PR) releases the lease, resets the interval, and makes `state`, `outcome`,
`consecutiveFailures`, and the alert surface describe the source truthfully.
Structured sources already did this; only the default list sources did not.
