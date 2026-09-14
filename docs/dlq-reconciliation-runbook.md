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
