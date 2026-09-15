# #231 production-remediation handoff

Status: no DLQ mutation was approved or performed. The owner selected
**preserve everything**. The production identity gate is intentionally failing
under the explicit 100% policy until the unconfirmed occurrences are resolved
through reviewed source-scoped work.

## Production evidence

Read-only evidence was collected on 2026-09-14 after authenticated operations
access was restored.

| Check | Observed result |
| --- | --- |
| Admission health | 3,084 active incidents; work backlog was nonzero but low during observation; DLQ count varied from the 227 baseline to 232, so it is not safe to derive a mutable batch from a single sample. |
| DLQ inspection | GitHub, Greenhouse, Lever, Ashby, Gmail, and destination-verification queues were inspected non-consumingly. Samples changed between requests; no replay or discard plan was created. |
| Identity aggregate | 8,703 confirmed and 3,493 unconfirmed source occurrences: 71.36% confirmed coverage. |
| Largest unconfirmed sources | `simplify-summer-2026` 1,698; retired `zapply-2027` 757; `speedyapply-2027-swe` 382; `speedyapply-2027-ai` 317. |
| Remaining unconfirmed sources | `vanshb03-summer-2027` 164; `canadian-tech-2027` 125; `northwestern-fintech-2027-quant` 50. |
| Identity repair endpoint | The all-scope dry run fails with D1 memory exhaustion because it loads the complete catalog into Worker memory. Server-side D1 aggregates supplied the counts above but cannot certify duplicate, projection, or presentation checks. |

## Disposition and residual ownership

Preserve all DLQ records. Do not bulk purge, replay, resume, or create a repair
token. This includes unattributed, paused, quarantined, defective, and
retired-history records.

- `zapply-2027` is retired historical data. Preserve it under source-operations
  ownership; do not resume it without an explicit reviewed exception.
- Simplify and SpeedyApply SWE were degraded during observation. Keep their
  unresolved occurrences with source operations; do not infer employer identity
  from board or program labels.
- All other unconfirmed source occurrences remain with the identity-review
  owner. Repair only source-scoped batches of at most 120, using reviewed,
  unexpired mappings and an owner-approved token/count.

## Policy and deployment state

The owner selected a 100% confirmed-coverage policy on 2026-09-14. The
configured production value must be explicit:

```text
IDENTITY_CONFIRMED_COVERAGE_FLOOR=1
```

Unconfirmed publication remains enabled. Therefore the daily integrity audit
must remain failing until all unconfirmed occurrences are resolved or retired
through a reviewed decision; it is not healthy at 71.36% coverage.

## Remaining work

1. Verify the OpenTofu application that explicitly binds the production
   coverage floor to `1` on both Workers. The binding is checked in on both
   Workers and both Wrangler configs; the saved plan still has to be reviewed
   and applied.
2. Replace the unbounded identity audit/repair read with a paginated or
   source-scoped implementation, preserving its token/count guards and full
   gate checks. Deploy only after tests and plan review. **Audit read: done.**
   `runPostingIdentityAudit` pages the catalog, merges the same facts the plan
   reports, and reproduces the 2026-09-14 production gate, coverage, duplicate,
   presentation, conflict, and outbox values exactly in 20 pages at 77-88 MB of
   live heap. The guarded repair read is unchanged and still whole-catalog, and
   the deployed Worker envelope has to be observed before the daily gate is
   trusted.
3. Export every page of the authenticated admission audit. Preserve a dated
   evidence artifact outside Git when it contains operational identifiers.
4. Reconcile each of the seven unconfirmed sources through reviewed mappings or
   explicit retirement/quarantine decisions; do not run a broad backfill.
5. Re-run admission health, DLQ, posting-identity, catalog-admission, and
   durable-state verification. Verify stable job IDs, timestamps, saved
   applications, receipts, notifications, and outbox records.
6. Complete #120's seven-day custom-route reverification observation. Attach
   the evidence to #231, then update #219 and #120.

## Acceptance criteria

Do not close #231 while any of the following is true: an unapproved DLQ batch
exists, the identity audit cannot execute fully, confirmed coverage is below
100%, the explicit floor binding is absent, or the seven-day custom-route
observation has not completed.
