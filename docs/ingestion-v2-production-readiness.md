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
- [x] Deploy the validated revision to both isolated dev Workers, with matching
  source controls, outbound delivery disabled, and a separate dev operations key.
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

## Current dev validation (2026-10-05)

All nine sources produced complete, verified immutable snapshots. A guarded dev
cutover gave Northwestern, Greenhouse Figma, and Ashby Mistral AI V2 catalog
ownership while the other six retained legacy ownership. Sources remain paused
until baseline reconciliation succeeds; outbound delivery remains disabled.

The dedicated publication cron completed at 20:54 UTC. Independent inspection
verified every immutable R2 page, its aggregate content hash, and the matching
D1 projection manifest, timestamp, and live watermark. Evidence is retained in
`.context/verification/ingestion-v2/publication-proof/scheduled-publication.json`.

The experiment stopped on ten quarantined rows: seven Workable HTTP 429s and
three Rippling redirects refused for using HTTP. Unsafe redirects now produce a
terminal blocked result instead of spending the timeout retry budget. Genuine
DNS and transport failures remain retryable. Workable subsequently returned 200
from an isolated Cloudflare Worker. Both dev Workers received the repair, and
all ten rows were reopened through reviewed replay previews and apply receipts.
The cohort still must drain and reconcile; replay acceptance is not a pass.

Further diagnosis found two distinct root causes. The D1 publication cron
unconditionally deleted the R2 pointer every ten minutes, even for unchanged
catalog content. This system defect created a three-minute handoff gap before
the R2 cron. The repair retains immutable pages only when their content hash
matches the new D1 projection, renews the pointer timestamp and watermark, and
still invalidates changed content until the dedicated publication completes.

The subsequent 23 quarantines were provider HTTP 429 responses: 22 Workable
postings and one Helsing posting. An isolated Cloudflare probe observed Workable
alternating between 200 and 429, including its documented public inventory API.
Helsing returned a Vercel Security Checkpoint locally and from Cloudflare, while
its reviewed official Greenhouse API returned the exact live posting. The V2
probe now uses a bounded Workable published inventory, caches successful and
failed tenant requests per delivery, and checks reviewed Greenhouse APIs when
application pages return 429. Posting IDs, tenant routes, redirects, complete
inventory shape, and public URLs must agree. Partial or failed responses cannot
prove closure. Rate-limit retries honor Retry-After and otherwise wait 15 minutes
then one hour; the three-attempt limit remains unchanged. Evaluator revision 4
forces a quiet policy regrade before promotion. Provider throttling can still
block the soak gate; the repair does not count replay acceptance as success.

A separate Cloudflare D1/R2/Queue experiment uses the production discovery,
admission, bootstrap, and catalog implementations. Its controlled 1,000-row
baseline settled independently: 999 blocked rows, one canonical Figma internship,
and zero notification events. Changed-role, duplicate-delivery, missing-snapshot recovery, and source-local
omission checks passed with durable assertions. Policy migration and rollback
also passed after correcting the legacy resolver composition in the harness.
Both legacy source polls returned zero failures, all three original canonical
identities and both notification records persisted, and the public catalog
exposed exactly those three roles. Legacy retained 50 unqualified fixture records;
all remain ineligible for catalog publication and alerts.
The fixture catalog and notifications are isolated from both normal dev and prod.
Cloudflare consumer analytics report zero errors, 64.1 MiB memory p99, and
0.27 seconds CPU p99. Captured queue traces contain no exceptions or failed
outcomes. An initial driver configuration error occurred before source discovery;
replacing its public self-fetch with a service binding repaired the harness.

Initial normal-dev runtime analytics showed no errors, but memory p99 reached
120.1 MiB, so resource headroom remains under review. The 24-hour clean dev gate
has not passed. Production ownership remains unchanged.

Local repair validation: 2,735 tests passed; typecheck and lint passed. Compiled
Worker integration validation passed (45 passed, one skipped). Both exact-head
CI runs for `6b60f0ee` passed, including resource budgets and infrastructure checks.
