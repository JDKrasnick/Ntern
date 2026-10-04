# Ingestion V2 Stage 2 production canary — 2026-10-03

## Decision

Keep Stage 1 shadow discovery enabled for `northwestern-fintech-2027-quant`
and `speedyapply-2027-swe`. Keep Stage 2 non-publishing admission enabled only
for `northwestern-fintech-2027-quant`. Legacy ingestion remains the production
catalog writer until Stage 3 selects and soaks the V2 writer.

This canary validates the Ingestion V2 implementation merged in PR #463 and the
trusted-community policy parity repair merged in PR #468. The deployed Worker
revision is `17d1fed445f2b5aadfea56481f6cbea1273e7cc3`.

## Stage 1 evidence

- Northwestern completed repeated 71-row snapshots. After the evaluator policy
  version changed, its ledger migrated without a direct D1 edit and the next
  identical run reported zero actionable rows.
- SpeedyApply completed repeated 1,253-row, production-shaped snapshots. Its
  latest V2 comparison reported zero actionable rows. The 25 legacy-actionable
  rows are the existing legacy resolution tail and do not represent a V2 diff.
- Both sources remained active and healthy with zero consecutive failures.
- The GitHub work queue and its DLQ returned to zero backlog.

## Stage 2 evidence

The Northwestern baseline contained 71 rows. The scheduled dispatcher created
three deterministic batches of at most 25 IDs. All three handoffs were
acknowledged, and every row settled after one admission attempt:

| Result | Rows |
| --- | ---: |
| Admitted to the non-publishing decision sink | 46 |
| Blocked by current destination evidence | 24 |
| Shelved by source policy | 1 |

The blocked rows were 16 `destination-blocked-uninspectable`, four
`destination-aggregate-board`, and four `destination-gone`. The earlier canary's
31 false `employer-unresolved` blocks were eliminated by applying the same
trusted-community policy and prior occurrence context used by legacy admission.
Three blocked rows were still catalog-eligible in the older legacy occurrence;
V2 had fresher negative destination evidence for two gone pages and one page
that currently could not be inspected.

The decision sink recorded 46 admitted effects with `notify = 0` and
`alert_eligible = 0`. The global notification-event ledger remained at 141,
with its newest event dated 2026-10-02, before this canary. Stage 2 uses the
recording sink, so it did not mutate the live catalog. Multiple later scheduler
cycles created no new handoff and did not increment any row beyond one attempt.

At the final check, the GitHub work queue, GitHub DLQ, admission queue, and
admission DLQ each had zero messages. The public `GET /api/jobs?limit=1` smoke
returned HTTP 200.

## Release and test evidence

- PR #463 exact head: `6a2d87efca5f5af191c66d41049f63dee2444edb`;
  merge commit: `2a561f4a77fc15eebb75eaa1e3b297ca9898ae1c`.
- PR #468 exact head: `c6ef4ec0bf62d02526a32afb53985d5715ee72bb`;
  merge commit and deployed revision: `17d1fed445f2b5aadfea56481f6cbea1273e7cc3`.
- Guarded production deploys `37160314066` and `37160846527` passed exact-main,
  saved-plan, migration, convergence, smoke, and monitor gates. The active
  ingestion Worker version is `cbab2489-d789-4120-a6f2-d668b3b36eec` at 100%.
- The final local full suite passed 164 files and 2,581 tests, with four live
  files and 313 tests skipped. Focused integration, ingestion CI, resource
  budget, built Worker E2E, lint, typecheck, and Worker build checks passed.
- Exact-head PR CI and post-merge main CI passed, including the full E2E job.

## Remaining gate

Stage 2 is deliberately non-publishing. Do not retire the legacy
migration/continuation path or widen admission until Stage 3 selects the live
catalog writer, proves idempotent catalog and notification effects, and
completes a broader source soak with the same queue, DLQ, health, and public API
checks.
