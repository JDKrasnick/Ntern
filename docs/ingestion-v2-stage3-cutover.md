# Ingestion V2 Stage 3 cutover

Stage 3 transfers one source at a time from legacy catalog writes to the
fault-isolated V2 admission lane. The schema and controls are additive. Keep the
source paused from the final recovery snapshot through bootstrap verification.

## Controls

All controls default off or empty. A source becomes V2-owned only when the same
source ID is present in the shadow, admission, live-writer, and legacy-disable
allowlists and all three global switches are enabled. Trusted-community alerts
require the additional alert allowlist.

| Control | Purpose |
| --- | --- |
| `INGESTION_V2_SHADOW_DISCOVERY_ENABLED` / `INGESTION_V2_SHADOW_SOURCE_ALLOWLIST` | Write complete immutable snapshots and the row ledger. |
| `INGESTION_V2_ADMISSION_ENABLED` / `INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST` | Dispatch and consume bounded row work. |
| `INGESTION_V2_CATALOG_WRITER_ENABLED` / `INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST` | Select the reconciler-backed V2 catalog sink. |
| `INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST` | Skip legacy catalog, occurrence, and notification writes for the source while preserving fetch, quality, health, and checkpoint work. |
| `INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST` | Enable reviewed trusted-community alert qualification for a V2-owned source. |

## Bootstrap

Pause the source through the operations API, wait for its source queue and
continuations to stop, and capture checkpoint, source health, queue/DLQ,
visibility, suppression, and notification counts. Enable the source-scoped V2
configuration, run one forced recovery so the active snapshot carries the current
evaluator version, and confirm the source remains paused.

A shared provider queue can contain healthy work for unrelated sources throughout
the cutover. After the pause fence is deployed, target-source quiescence can
establish drain without requiring that entire queue to become empty. Forced ATS
messages carry `forceRequestedAt`; Greenhouse continuations preserve that original
request time. A paused source rejects missing or stale force authorization.
Explicit recovery records its validation request with the pause and remains
allowed. Legacy forced messages without an authorization timestamp are skipped
while paused; issue a new recovery if such a request still needs validation.

For this source-scoped drain proof, keep the target healthy and paused, prohibit
further replay/recovery requests, and wait at least 16 minutes after both its final
pause and deployment of the fence. This exceeds the [15-minute queue invocation
wall limit](https://developers.cloudflare.com/queues/platform/limits/). Capture
two identical observations at least 30 seconds apart of the pause/configuration
version, checkpoint (including zero pending Greenhouse detail IDs), complete
active snapshot/hash, and notification count. Provider and V2 DLQs must be empty,
and current-version resource/error, catalog, and cost gates must still pass.
Recheck the exact signed bootstrap preview before applying. Do not use this
alternative with an older Worker or a source that is quarantined, changing,
receiving new forced work, or missing complete acquisition evidence.

The scheduled dev-soak checkpoint must also show an initialized one-hour cost
window below both production alert boundaries: fewer than 60 V2 shadow runs and
fewer than 100,000 D1 rows written. A breach blocks cohort promotion even when
catalog parity and queue drain are otherwise healthy.

The checkpoint also fails on any queue message that reaches its final configured
delivery attempt during the observation window. A later retry, deferral, or
ledger resolution does not erase that exhaustion signal; diagnose it and restart
the clean soak window after the fix is deployed. Set
`INGESTION_V2_SOAK_STARTED_AT` to that deployment's ISO-8601 timestamp for a
restarted local monitor; the rolling 24-hour boundary still applies if it is
later.

Dry-run:

```bash
npm run ingestion:v2:bootstrap -- --source <source-id>
```

Review `sourceStatus`, checkpoint pending fields, ledger counts, snapshot hash and
version, active/actionable counts, excluded history, suppressed active rows,
visibility estimate, `expectedNotifications: 0`, write estimate, and expiry.
Apply the exact reviewed values before the 15-minute token expires:

```bash
npm run ingestion:v2:bootstrap -- --source <source-id> --apply \
  --repair-token <token> --expected-active <count> --expected-actionable <count>
```

Apply refuses an unpaused source, queued or processing admission work, count or
snapshot drift, an expired/tampered token, an incomplete D1/R2 snapshot, or a
missing checkpoint. The receipt is immutable; repeating a completed apply is
idempotent.

## Verification and cohort advance

Keep all 12 production cron expressions on the established ingestion Worker.
With `INGESTION_V2_ISOLATED_WORKERS_ENABLED=true`, it forwards the `:01` D1 and
`:05` R2 phases to `CATALOG_PUBLISHER` and the `:09` admission dispatch to
`ADMISSION_WORKER` through private service bindings. The dedicated Workers have
no public routes, previews, or cron registrations. Admission's retained native
scheduled handler is inert. The publisher accepts lingering native projection
deliveries during propagation, sharing a 16-minute phase lease with private
delegation so heavy builds cannot overlap. Existing D1/R2 pointer fences remain
authoritative; a busy lease never advances completion markers. Admission queue
consumption stays on the dedicated Worker.

The production schedule API reported the earlier ownership transfer on
2026-10-08, but live tails still delivered those events to ingestion more than
30 minutes later, and publisher deliveries persisted after removal while new
ingestion registrations remained unobserved. Check actual scheduled or delegated
publisher invocations, current-version resource
samples, fresh durable admission/D1/R2 completion markers, and matching valid
catalog pointers/pages before advancing. The projection expressions are now `1,11,21,31,41,51 * * * *` and
`5,15,25,35,45,55 * * * *`: fresh registration identities replace the expressions whose live deliveries
still reached the old owner after restoration. Legacy expressions
remain accepted by handlers during propagation, but are not registered.
Registered schedules and a drained
duplicate-delivery probe alone do not prove scheduled work or writer ownership.

Before a cutover, replay the pinned historical snapshots through the production
GitHub adapters and V2 normalization/diff path:

```bash
npm run test:ingestion:history
```

The gate covers three immutable revisions for each of the six configured
community feeds. It verifies one-to-one parsed row preservation, deterministic
R2 envelopes, order-independent snapshot identity, new/changed/missing
classification, and the two-complete-snapshot closure rule. Its checked-in
summary digest makes row, identity, or transition drift fail the run.

Apply migrations `0050_ingestion_v2_omission_closure.sql` and
`0051_ingestion_v2_qualification_cadence.sql` before deploying the updated
ingestion Worker or enabling the writer. Shadow and recording mode also read
the new metadata columns.
Complete-snapshot omissions persist a closure intent; each discovery delivery
commits at most 25 source occurrence closures and retries until the remaining
intents are drained. A reappeared row fences out an older closure. Terminal row
rejections revoke that occurrence through the leased effect boundary, while
other live source occurrences retain the canonical role.

Trusted-community qualification counts distinct complete fetch sequences in
the ledger, including cadences observed before admission finishes. Queue
duplicates, retries, and bounded legacy continuations do not add evidence.
Unchanged candidates that still need qualification return to the existing
bounded admission dispatcher. Baseline and policy-migration rows remain silent;
an eligible post-baseline occurrence promotes its existing job through the
deterministic notification receipt.

Drain admission work and reconcile terminal row totals to the planned active
count. Confirm baseline notification count remains unchanged, pending legacy
fields are absent, the active checkpoint version matches the V2 snapshot,
eligible roles remain visible, and queue/DLQ return to zero. Resume the source
only after each admitted ledger job ID matches its persisted occurrence and
resolves to the open canonical job. Catalog reconciliation returns its committed
identity to the admission consumer; a proposed ID is not proof of persistence.
Then observe at least three complete cadences, including one unchanged cadence
with zero reopened work and one expected change. Compare row decisions,
visibility, omissions, notifications, retry/quarantine, source health, Worker
errors, and D1/R2 pressure before adding another source.

Store timestamped evidence under
`.context/verification/ingestion-v2/stage-3/<source-or-cohort>/`. The first live
writer cohort remains a canary. Production expansion and legacy removal require
the seven-day clean soak in the approved plan.

Owner decision on 2026-10-07 authorizes expedited source-by-source production
writer expansion before that waiting period. Current snapshot integrity, signed
silent bootstrap, durable catalog parity, queue drain, cost, and resource
headroom checks still gate each cohort. Report the seven-day soak as pending;
this exception does not authorize post-soak legacy removal.

The isolated dev stack runs a read-only checkpoint every hour after the workflow
lands on the default branch. Run the same checkpoint on a feature branch with
the workflow dispatch or locally with Cloudflare credentials:

```bash
npm run ingestion:v2:dev:soak
```

For a reviewed experiment profile, set `INGESTION_V2_DEV_CONFIG` to its dev
ingestion JSON configuration. The checkpoint rejects a production Worker name
or enabled outbound delivery and compares both live dev Workers with that
profile. Sources owned by V2 also require matching durable occurrence links,
canonical jobs, policy versions, and revoked catalog eligibility.

Each checkpoint verifies the exact 12 production cron expressions, live dev
rollout controls and outbound suppression, the public dev catalog, and every
configured admission source. It checks source freshness, complete comparisons,
D1/R2 snapshot identity and envelope integrity, cost windows, stale handoffs,
expired leases, fresh scheduled R2 catalog publication, Worker runtime failures
and resource percentiles, and all nine work queue/DLQ pairs. The observation
window starts no earlier than the latest ingestion deployment; a newly deployed
Worker cannot claim a completed 24-hour soak. Resource-headroom warnings require
review before promotion. JSON evidence is retained as a workflow artifact for 14 days. A clean
24-hour dev soak is the pre-production gate; it does not replace the guarded
production canary or the seven-day production soak.

Unresolved delivery incidents remain a readiness failure regardless of the
observation window or deployment time. The collector samples the oldest 200
unresolved records through the partial index, excludes resolved history, and
labels the sample explicitly. Recovery must write a durable `resolved_at`
receipt; a new deployment cannot clear an incident.

## Bounded operations dispatch

`POST /internal/operations/ingestion/dispatch` with `{"sourceId":"<owned-source-id>"}`
uses the operations key to forward one source to the private admission Worker.
Use it after queues drain to advance baseline work without waiting for the next
ten-minute dispatch. It retains the existing 500-row limit, message sizing, and
consumer concurrency. Requests cannot supply a larger limit or a source list.

Matched discovery, admission, writer, and legacy-disable controls are required.
The Worker rejects incomplete active snapshots and outstanding queued,
processing, quarantined, or unacknowledged source work. Billing and isolation
guards remain active. Manual dispatch leaves the natural source cursor and
scheduled completion markers unchanged; its own phase markers identify manual
work. It does not bootstrap or resume a source. Verify resource/cost headroom,
queue drain, baseline silence, and catalog parity before each advance.

Private admission requests retry D1 connection resets through the bounded
statement retry helper. D1 overload, internal errors, and typed statement stalls
after bounded retries return HTTP 503 with
`Retry-After: 600`, record a failed dispatch phase, and defer pending work to the
next natural ten-minute cadence. They do not retry pressure immediately or
report completion. A later completed phase and fresh queue, parity, cost, and
resource evidence are still required before advancing ownership.

The catalog publisher uses the same deferral for D1 overload, internal errors, or typed stalls
in billing checks, lease acquisition or release, and projection work. Its private
response retains `completed: false`, with `failureClass: d1-overloaded` or
`d1-internal` or `d1-stalled`, and a failed publication-attempt marker. Scheduled ingestion work
also defers these D1 failures to its next cadence without an immediate retry.
Partial maintenance passes retain failed steps and a failed overall completion
marker. Neither a typed deferral nor an earlier successful marker proves that
the latest work completed; the production gates still require current success.

## Rollback

Pause the source, disable V2 discovery for it so no new row work is created,
and allow claimed row effects to finish or leases to expire. Remove it from the
trusted-alert and admission allowlists, then remove it from the live-writer
allowlist. Remove the source from
`INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST` to restore legacy
write ownership. Preserve V2 queue/DLQ messages, tables, receipts, and snapshots.
Run one legacy cadence, reconcile catalog state and notification identities, and
resume only after source health, visibility, and zero duplicate notifications are
proven. Re-enable V2 by repeating the guarded source sequence; never purge V2
state as part of rollback.

### R2 schedule compatibility after deployment

Keep the configured explicit-minute R2 schedule (`4,14,24,34,44,54 * * * *`). Both publishers also accept the equivalent prior expression (`4-54/10 * * * *`): production scheduled events continued using it more than 25 minutes after the schedule API reported the replacement on 2026-10-06. An API schedule listing or a successful deployment is insufficient evidence of publication. Check a completed scheduled event, the durable completion marker, and a valid R2 pointer/pages. Isolation gates still select the sole publisher; accepting the old expression must not transfer catalog or alert ownership.

### Bounded R2 publication

Production's 5,059-group catalog exceeded the combined Worker's memory limit during whole-catalog R2 hydration on 2026-10-06. The R2 phase now pins the content-addressed D1 manifest and reads its groups lazily in 25-row queries. It publishes at most 100 groups per R2 page, rejects pages above 8 MiB before activation, and checks the complete ordered content hash before activating the pointer. D1 projection rebuilds remain a separate memory-heavy phase and must independently pass headroom/soak gates.

The production size audit measured 128,437,276 serialized bytes across 4,840 current groups, a largest card of 563,279 bytes, and a largest 100-group page of 5,153,064 bytes. A 4 MiB page cap would reject three valid live pages. The 8 MiB cap is bounded and covers that observed catalog. The compiled 5,059-group fixture must contain at least 128 MB of serialized cards, include a valid page above 4 MiB, stay within 8 MiB per page, and never hydrate more than 100 unpublished groups. Natural deployed publication and runtime headroom remain required; group count alone does not establish a representative memory test.

A schema-1 pointer can include `pageVersion`, a private immutable page namespace; `version` continues to identify the catalog content. Read pages through `pageVersion ?? version`. Existing pointers remain readable. Unchanged streams retain verified pages. Repairs copy validated pages into a new private namespace, so partial scans and concurrent publications cannot overwrite pages already visible to readers. Proven unpublished candidates are cleaned up; an uncertain final pointer-write acknowledgement preserves its pages because a newer writer may already retain them. Completion markers advance only after successful publication or yielding to a newer pointer.

The compiled 5,059-group regression verifies real migrated D1-to-R2 publication while enforcing a maximum of 100 fetched-but-unpublished groups. Also verify the natural scheduled event, durable completion marker, valid pointer, all page/content hashes, queue drain, and current-version memory/error samples after deployment.

### Transient R2 publication failures

A documented R2 Workers `InternalError` (`10001`) defers the publisher to its next ten-minute cadence. Private scheduling returns `503`, `Retry-After: 600`, and `completed: false`; the caller records that deferral instead of claiming publication completed. Unknown failures remain fatal.

Conditional activation writes are not retried inside the delivery: a lost acknowledgement can mean the pointer already committed. Existing ETag fences, staged-page retention, and D1 fallback remain in effect. A failed phase remains durable, and ownership advancement still requires successful current-version phase evidence plus complete matching D1/R2/public catalog verification. Reject an older completion marker when a newer publication attempt failed.

[Cloudflare R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/)

### Repairing application hosts before ownership

If an official provider changes its application host, keep the source paused while
deploying the reviewed exact host. An authenticated `POST /internal/poll-source`
with `provider=greenhouse`, the explicit `sourceId`, and `seedOnly=true` performs a
forced full acquisition with a quiet historical baseline. This mode requires a
healthy, paused, published Greenhouse source without V2 writer ownership. Bounded
detail continuations retain quiet mode and the original force authorization;
resuming or transferring ownership invalidates further quiet continuations.

Before restoring the source, independently verify complete checkpoint coverage,
no pending details, healthy paused state, complete immutable snapshots where V2
discovery is enabled, and unchanged notification-event counts. Then use the normal
signed bootstrap and source-by-source ownership gates. Silent acquisition does not
waive admission, identity, URL, or catalog parity checks.
