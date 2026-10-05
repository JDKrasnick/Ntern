# Ingestion V2 production readiness

The owner authorized dev validation and a staged production rollout on 2026-10-05.
Production ownership advances only after the gates in the
[cutover runbook](ingestion-v2-stage3-cutover.md) pass. A code deployment alone
never transfers source ownership.

## Dev cohort and boundaries

| Sources | Discovery | Admission | Catalog owner | Outbound delivery |
| --- | --- | --- | --- | --- |
| Northwestern | V2 | V2 | V2, bootstrapped canary | Suppressed; record intent |
| SpeedyApply SWE and AI, Vansh, Canadian Tech, Simplify | V2 | V2 recording sink | Legacy | Suppressed |
| Greenhouse Figma, Lever Palantir, Ashby Mistral AI | V2 | V2 recording sink | Legacy | Suppressed |

Provider workers and authenticated forced provider polling now pass the same
V2 discovery and ownership controls as GitHub polling. Unallowlisted sources
retain their existing behavior. API and ingestion dev controls match so a forced
poll cannot bypass the writer boundary.

## Gates

- [x] Provider regression tests cover complete discovery, legacy-write suppression,
  and fail-closed ownership for Greenhouse, Lever, and Ashby.
- [x] Historical six-board replay and existing multi-day, retry, omission,
  baseline-silence, and idempotent catalog tests pass locally.
- [x] Soak checks exact cron expressions, all configured admission sources,
  immutable R2 envelopes, publication, runtime errors, and live rollout controls.
- [ ] Deploy the validated revision to both isolated dev Workers.
- [ ] Reconcile all nine sources to snapshots, durable decisions, and queue drain.
- [ ] Prove large-board admission resource headroom and explain every retry/quarantine.
- [ ] Exercise provider catalog effects, recovery, and rollback in dev.
- [ ] Complete 24 clean dev hours after the final repair deployment.
- [ ] Obtain green exact-head CI and merge the reviewed repair.
- [ ] Deploy through the guarded production workflow with ownership unchanged.
- [ ] Pause, recover, review and apply bootstrap, then transfer one small production source.
- [ ] Verify real catalog visibility, baseline silence, changed and unchanged cadences,
  deterministic notifications, queue drain, and rollback evidence.
- [ ] Complete seven clean production days before broader ownership expansion.

## Evidence and interpretation

Store timestamped reports under `.context/verification/ingestion-v2/` and record
the deployed version, source controls, snapshot identity, decision totals,
notification receipts, queue/DLQ state, runtime outcomes, and D1/R2 usage.
The public API can succeed using D1 while R2 publication is broken, so both
publication pointers and scheduled completion markers are mandatory.

A healthy shadow classification is not evidence of an independent admission
attempt: confirm attempt counts and recording-sink receipts. A settled ledger is
not evidence of catalog publication: reconcile source occurrences and canonical
jobs. A missing notification during baseline is expected; post-baseline eligible
changes must produce exactly one deterministic event.
