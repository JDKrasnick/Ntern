# Standardized job ingestion architecture

## Goal

All production sources cross one provider-neutral boundary before catalog
policy is applied. Connectors prove that a snapshot is complete and preserve
provider identity; shared processing owns cleaning and eligibility; pure
reconciliation decides catalog changes; persistence only stores those changes.

This refactor deliberately preserves existing source IDs, URL/fingerprint job
IDs, eligibility decisions, quiet baselines, and notification behavior.
Eligibility improvements ship separately after compatibility is proven.

```mermaid
flowchart LR
    Sources["GitHub · Lever · Greenhouse · Ashby · future boards"]
    Config["Reviewed source configuration"]
    Connectors["Thin source connectors"]
    Snapshot["Complete neutral posting snapshot"]
    Processor["Shared cleaning and classification"]
    Reconciler["Quality, dedupe and reconciliation"]
    Store["Catalog and source health"]
    Product["API, mobile and notifications"]
    Monitor["Logs, metrics and incidents"]

    Config --> Connectors
    Sources --> Connectors
    Connectors --> Snapshot
    Snapshot --> Processor
    Processor --> Reconciler
    Reconciler --> Store
    Store --> Product

    Connectors -. outcomes .-> Monitor
    Processor -. decisions .-> Monitor
    Reconciler -. changes .-> Monitor
    Store -. health .-> Monitor
```

## Contracts

A `SourceConnector` returns a complete `SourceSnapshot`. Each
`SourcedPosting.externalId` is stable within its source: ATS posting IDs for
Lever, Greenhouse, and Ashby, and document path plus normalized application URL for
Markdown. Two Markdown rows that share one normalized application URL are one
destination, so the repeat is dropped and still counted in `rawCount` rather
than failing the snapshot. Row numbers remain diagnostics only.

Connectors own transport, pagination, schema validation, source identity,
completeness, stable provider IDs, and reviewed URL contracts. They classify
failures so the runner can retry transport, `429`, and `5xx` and quarantine
configuration, schema, identity, and URL-contract failures. They do not decide
whether a structurally valid posting is a technical early-career role.

The shared processor returns processed listings and an explicit decision for
every posting. It owns text cleanup, generic URL safety, work-mode/location
normalization, lifecycle and technical classification, season inference,
compensation, and declared requirement extraction. `lifecycleAuthority` records
where the lifecycle signal comes from: `title` requires explicit internship,
co-op, apprenticeship, new-grad, or entry-level wording; `posting` trusts a
provider field that explicitly marks that row as an internship; and `source`
trusts a reviewed early-career-only document for every row it lists. A generic
technical title, experience-range prose, or “junior” alone never qualifies.

The reconciler is pure. It calculates creates, updates, first omissions,
second-omission closures, and deterministic notification events. One snapshot
that lists a role twice — across documents or behind different tracking links —
merges into one role with one alert. A role remains open while any source
occurrence is open. Failed, incomplete, malformed, or suspicious raw-zero
snapshots never reach reconciliation.

The store persists catalog records, occurrences, checkpoints, deterministic
outbox records, and source health. An occurrence is written only when its
presence, omission streak, role, or payload changes; a confirmation costs no
write because the checkpoint carries the active ID set. Recording an outbox
event is the alert gate, so a retried snapshot re-derives the same event ID and
stays quiet. Checkpoints advance only after all writes for a snapshot succeed.
Store indexes use the already-processed catalog state and never re-run
classification.

### Catalog and source time facts

Catalog timestamps and provider timestamps answer different questions and are
never substituted for one another:

- `Internship.firstSeenAt` is the immutable time InternNotifs first observed the
  canonical job. It is not a provider creation or publication time.
- `Internship.catalogVisibleAt` is the immutable time that canonical job became
  visible in the InternNotifs catalog. `catalogRecency=normal` sorts by this
  value; `baseline` remains browseable but sorts after every normal job.
- `SourceOccurrenceState.firstObservedAt` is when InternNotifs first observed
  that source-local posting. Its precision field marks legacy unknowns.
- `SourceOccurrence.firstAttachedAt` is when that source occurrence was first
  attached to the canonical catalog job. Attaching a provider baseline to an
  existing community job does not change the job's catalog timestamps or rank.
- `SourceOccurrence.providerTimestamp` retains the provider's declared
  `published` or `updated` semantics. In particular, an `updated` value is never
  converted into a creation, observation, attachment, or visibility time.

The open sparse-index key starts with the recency rank and then uses
`catalogVisibleAt#jobId`. Normal rows use rank `3`; baseline rows use rank `1`.
This makes one descending query return every normal role before any baseline
role. Legacy unranked normal keys remain readable during rollout and the catalog
index audit canonicalizes them.

## Compatibility and rollout

Migration order is Greenhouse, Lever, general GitHub Markdown, then Quant
Markdown. During migration, `RawListing` remains a deprecated alias for
`ProcessedListing`, and the legacy `SourceAdapter`/`SourceFetchResult` names
remain aliases for the neutral connector contract where callers still need
them.

The first trusted snapshot for a source is always quiet. Unchanged successful
snapshots are healthy and can advance omission streaks because they confirm
the same complete active snapshot; they reconcile omissions only, so identical
source content never rewrites the catalog. One omission marks an occurrence
missing; the second consecutive complete success closes it. Updates never
become new job alerts.

## Runtime and deferred scaling

The existing poll Lambda remains the orchestrator. Greenhouse keeps its
SQS-backed shadow/published scheduling, Ashby's five reviewed boards remain
adapter-only and shadow-only pending their runtime issue, and Firecrawl remains discovery-only.
Per-source queues for every provider, dynamic operator configuration, and a
management UI are deferred until source volume requires them.

Source health records and structured events make unchanged success, transient
provider failure, rejected snapshots, persistence failure, and stale sources
distinct. Metrics use provider/outcome/category dimensions; source IDs stay in
logs and health records to avoid unbounded metric cardinality.

Provider admission and incident response remain provider-specific:

- [Lever company onboarding](lever-company-onboarding-plan.md)
- [Lever monitoring and recovery](lever-monitoring-plan.md)
- [Greenhouse operations](greenhouse/README.md)
- [Ashby discovery, admission, and adapter](ashby-onboarding.md)

## Ingestion V2 foundation (Stage 1)

`docs`/plans describe fault-isolated ingestion as three gated stages. Stage 1 is
the additive foundation and side-effect-free shadow discovery; the legacy
migration/continuation loop stays authoritative and is the only thing that can
create a job, occurrence, notification, or admission write.

- `cloudflare/migrations/0045_ingestion_v2.sql` adds `ingestion_snapshots`,
  `ingestion_rows`, and `ingestion_v2_shadow_comparisons`. Nothing legacy is
  altered; the migration is re-runnable.
- `src/ingestion-v2/` holds the pure contracts: `normalize.ts` (deterministic,
  order-independent snapshot and material hashing), `diff.ts` (full-board diff),
  and `shadow-discovery.ts` (orchestration). The D1 repository and R2 snapshot
  store live in `cloudflare/ingestion-v2-store.ts`.
- The runner invokes the shadow hook at `src/poll.ts` after the legacy fetch
  passes `sourceQualityFailures` and before any legacy admission write. The hook
  never throws: a shadow failure is logged as `ingestion_v2_shadow_failed` and
  the legacy delivery proceeds.
- `INGESTION_V2_SHADOW_DISCOVERY_ENABLED` (default `false`) gates the whole
  feature; `INGESTION_V2_SHADOW_SOURCE_ALLOWLIST` optionally bounds rollout to a
  comma-separated set of source IDs.
- Shadow mode writes only its own D1 state, a content-addressed R2 object under
  `ingestion-v2/snapshots/<source-id>/<snapshot-hash>.json`, and a per-source
  comparison. It never enqueues admission, mutates a checkpoint, or touches the
  catalog.

The full-board diff compares every normalized row against the compact ledger and
classifies it as `new`, `changed`, `stale-policy`, `retryable`, `unchanged`,
`reappeared`, or `missing`. New, changed, stale-policy, reappeared, and due-retry
rows are actionable; unchanged settled rows are not. Missing rows increment
omissions only after a complete snapshot and become `absent` on the second
consecutive complete miss. Incomplete or failed snapshots neither activate nor
advance omissions. A repeated identical snapshot produces an empty actionable
set and rewrites nothing.

The protected `GET /internal/operations/ingestion-v2` endpoint returns the latest
shadow comparison per source (or one source with `?sourceId=`). It requires the
`X-Operations-Key` header and is otherwise a 404.

## Ingestion V2 fault-isolated admission (Stage 2)

Stage 2 adds a dedicated `intern-notifs-admission-v2` queue and DLQ and makes
each ledger row settle, retry, or quarantine independently. It stays
feature-flagged and, before Stage 3 cutover, runs in verification mode: the
catalog writer is replaced by a recorded decision sink, so admission writes
ledger state and captures the decision it would have published without mutating
the live catalog.

- `cloudflare/migrations/0046_ingestion_v2_admission.sql` adds
  `ingestion_admission_handoffs`, the durable dispatch receipt. The lease,
  attempt, retry, decision, and failure columns already live on `ingestion_rows`.
- `src/ingestion-v2/admission/` holds the pure contracts and orchestration:
  `message.ts` (versioned message, deterministic batch ID, 25-ID limit,
  canonical ordering), `taxonomy.ts` (business/row-transient/infrastructure
  classification and the 60 s / 5 min retry schedule), `transitions.ts` (the row
  state machine), `dispatcher.ts`, `consumer.ts`, `migration.ts`, `operations.ts`,
  `evaluator.ts` (reuses `processPosting`, `classifyDestination`, and
  `evaluateCatalogAdmission`), and `recording-sink.ts`.
- The scheduled dispatcher finds pending rows and stale queued rows with no valid
  handoff receipt, commits them `queued`, records a handoff, and hands bounded
  messages to the queue. A failed send leaves the rows recoverable once the
  handoff goes stale.
- The consumer reads the referenced snapshot once per batch, leases each row with
  the message's snapshot/material/policy intent, and lets each row settle,
  schedule a retry (initial attempt plus two), or quarantine. A duplicate, stale,
  or contended delivery is a no-op. A systemic failure (missing R2 object, D1
  unavailability, incomplete snapshot) releases the lease, retries the delivery,
  and never consumes a row attempt or quarantines a row.
- Policy migration reopens a bounded batch of stale settled rows under the
  current version without hiding previously visible roles or setting a
  source-wide suppression. Baseline and policy-migration work emit no
  notification; only a genuinely new post-baseline role does.
- `INGESTION_V2_ADMISSION_ENABLED` (default `false`) gates admission;
  `INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST` optionally bounds rollout. The
  dispatcher only produces messages for sources on the allowlist, and the
  consumer acknowledges anything else as a no-op.
- `GET /internal/operations/ingestion/rows?sourceId=&state=&cursor=` returns a
  bounded, sanitized page plus a source overview (pending/queued/processing/
  settled/quarantined/absent, oldest work, current snapshot).
  `POST /internal/operations/ingestion/rows/replay` previews with
  `{ sourceId, externalId }` and applies only when the returned `replayToken`
  is echoed back; it refuses an in-flight row and an ID absent from a retained
  complete snapshot. Both require `X-Operations-Key` and are otherwise a 404.

### Stage 2 known gap (owned by Stage 3)

Stage 2 ships the queue, lease, retry, quarantine, dispatch, and replay
machinery, but no producer yet turns Stage 1 discovery output into dispatchable
work. Shadow discovery writes every board row `settled`, the dispatcher selects
only `pending`/`queued`/expired-`processing`, and `migrateAdmissionPolicy` is not
yet scheduled. Consequently a real source produces no admission messages until
Stage 3 maps the diff's `actionableExternalIds` (or a policy-migration pass) into
the lane. This is intentional: both flags are default off and the admission
decisions are recorded, not published. The end-to-end suites cover the lane by
seeding dispatchable rows directly. Two writers share `ingestion_rows`, so the
shadow upsert preserves admission-lane state (`pending`, `queued`, `processing`,
`quarantined`) and omission increments skip a leased `processing` row.
