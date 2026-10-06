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
and observe at least three complete cadences, including one unchanged cadence
with zero reopened work and one expected change. Compare row decisions,
visibility, omissions, notifications, retry/quarantine, source health, Worker
errors, and D1/R2 pressure before adding another source.

Store timestamped evidence under
`.context/verification/ingestion-v2/stage-3/<source-or-cohort>/`. The first live
writer cohort remains a canary. Production expansion and legacy removal require
the seven-day clean soak in the approved plan.

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
