# Ashby monitoring runbook

The `InternNotifsAshby` stack is an independently deployable polling plane over
the retained internship and user tables. It owns a staggered half-hour
scheduler, dispatcher, encrypted FIFO work queue, worker, work DLQ, scheduler
DLQ, four alarms, a dashboard, and operations-discovery parameters.

## Admission before deployment

Every board must have committed `evidence.json` and metadata-only `probe.json`
fixtures, pass `npm run ashby:manifest`, and enter `reviewedAshbySources` in
`shadow`. Admission is a reviewed code change. There is no mutable runtime
admission endpoint.

The owner may explicitly approve expansion when an employer-proven board has a
known public technical early-career page that Ashby marks unlisted. Record the
decision as `initialRoleRequirementOverride`; it waives only the requirement
for a qualifying listed role at admission. The runtime remains listed-only and
will not ingest the unlisted page, but it will monitor future listed roles from
that board.

The owner must confirm that the employer-controlled careers page contains the
exact `jobs.ashbyhq.com/{board}` URL, the observed company is unambiguous, every
application host is expected, and the qualifying role samples are in product
scope. This approval admits a source only to shadow; it is not promotion.

## Shadow verification

After deployment, use the shared operations API/dashboard to confirm each board
has at least three successful snapshots spanning at least 24 hours. For each
board verify:

- exact Ashby identity and schema, zero malformed rows, and no path violations;
- no unexplained application host and link failures at or below 20%; inspect
  `applicationLinksChecked` and `applicationLinkFailures` for each board;
- reviewed inclusion/exclusion samples and a rehearsed quiet baseline;
- health/checkpoints exist, but there are no catalog, occurrence, outbox,
  user-store, or publisher writes from the shadow run.

Pause and resume one source, issue an operator replay, inspect queue and DLQ
counts, and verify the four Ashby alarms and `InternNotifs-Ashby` dashboard.
Also exercise the safe quarantine flow: provide a reason, recover the source
through a forced clean validation while it remains paused, inspect the new
trusted snapshot, and only then resume normal scheduling.
Operator pause, backoff, and replay take precedence over normal scheduling.
Published boards run every thirty minutes; shadow boards run every three hours.
Active and quiet tiers remain health classifications and do not alter cadence.

## Acknowledged-empty boards

A reviewed board whose API still resolves its identity but lists no roles is
empty, not broken: `api.ashbyhq.com/posting-api/job-board/{board}` returns `200`
with `{"jobs":[]}`, while a removed board returns `404`. Do not force-recover an
unacknowledged empty board — the raw-zero guard rejects it, so every recovery
re-fails and requeues the quarantine.

When the owner re-checks the live board and accepts the emptiness, record an
`emptyBoardAcknowledged` declaration on the reviewed source with the owner, the
UTC check time, and the reason. The declaration makes the board dormant: a
zero-row snapshot is expected rather than parser drift, while identity, schema,
application-host, and link checks still apply. Monitoring continues, so the
board's next listed role is ingested normally.

Once the declaration is deployed, recover the board with `recover` and then
`resume` it. The forced run now accepts the zero-row snapshot, resolves the
incident, zeroes `consecutiveFailures`, and rewrites the shadow checkpoint, so
zeros stop tripping the guard.

A declaration expires after 180 days, matching the admission re-verification
window; the manifest fails until the owner re-checks the live board and updates
`acknowledgedAt`. Remove the declaration when the board refills: zero rows are
drift again, and the guard re-arms on the first non-empty snapshot.

## Promotion

Promotion is per board. Add committed `promotionEvidence` containing three
unique clean snapshot run IDs spanning at least 24 hours, their counts and link
results, stable identity and host approvals, and the named quiet-baseline
approval. Then change only that individually qualified source from `shadow` to
`published`, review the config diff, rerun the manifest and focused tests, and
deploy `InternNotifsAshby`. The manifest rejects publication when this evidence
is absent or incomplete. A single deployment may contain several independently
approved promotions.

An owner may explicitly authorize publication before the normal observation
window completes. Record that exceptional decision as
`observationWindowOverride`, retain at least one clean link-checked snapshot,
name a follow-up time after the skipped window would have completed, and create
a tracked follow-up review. This override changes timing only; it does not
bypass identity, schema, application-host, link, quiet-baseline, or named-owner
approval checks.

Verify that the first published run creates the source checkpoint as a quiet
baseline and creates no notification event. A later genuine addition follows
normal reconciliation and notification behavior. Updates are not new-role
alerts; one complete omission marks a role missing and the second consecutive
complete omission closes it.

## Provider outage

Do not replay the fleet while Ashby is returning widespread transport, `429`,
or `5xx` failures. Confirm the provider-wide pattern in incidents and alarms,
leave bounded backoff in control, and pause affected sources if retries are
adding pressure. Preserve the last trusted catalog state. After the provider is
healthy, recover one representative shadow source first, verify its identity,
schema, hosts, and link results, then resume the remaining sources gradually.

## Schema or identity drift

For API-version, malformed-row, wrong-board path, or unexplained application-host
failures, quarantine the affected source and do not override the rejected
snapshot. Capture only redacted diagnostics, reproduce against a metadata-only
fixture, and update the adapter or reviewed host evidence through code review.
Deploy the reviewed fix, run a forced recovery validation while the source is
paused, and resume only after a trusted complete snapshot succeeds.

## Recovery and rollback

For a bad or stale board, quarantine it with a concise reason before
investigating. `recover` queues one forced validation but deliberately leaves the
source paused. Resume only after that run returns the source to healthy. Redrive
DLQ work only after the underlying condition is fixed; FIFO message groups
preserve per-source ordering.

To roll back publication, change the affected source back to `shadow` and deploy
Ashby. This stops catalog writes without blocking other boards. Do not delete
shared tables, checkpoints, or source occurrences. If the entire fleet is
unsafe, disable the Ashby schedule or pause all Ashby sources, then redeploy or
roll back only `InternNotifsAshby`.
