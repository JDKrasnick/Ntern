# Cloudflare dev ownership experiment

Run date: 2026-10-05. Production ownership and outbound delivery remain unchanged.
The full readiness gate is tracked in [production readiness](ingestion-v2-production-readiness.md).

## Two independent experiments

The normal dev cohort exercises nine live GitHub and ATS sources. Each source
must first finish independent recording-sink admission, then pass a reviewed,
paused bootstrap before V2 receives catalog ownership. Matching controls on
both dev Workers prevent authenticated forced polling from bypassing ownership.
A source cannot advance with an unsettled or quarantined row. After all sources
reconcile, the run verifies scheduled R2/D1 publication, paused recovery,
unchanged decisions, Figma rollback and restoration, then resumes the cohort.
Only subsequent clean scheduled operation can start the 24-hour soak clock.

The controlled experiment isolates its own D1, R2, Queue, DLQ, operations key,
and two Workers. Its driver presents complete HTTP source snapshots to the
production GitHub adapter and discovery implementation. Its consumer runs the
production ingestion Worker against the real queue and public official Figma
application URLs. Three selected, currently published internships supply genuine
eligible destinations; 999 synthetic senior-role rows exercise rejection and
full-board processing. No fixture notification reaches a device or email address.

| Assertion | Durable evidence |
| --- | --- |
| Silent 1,000-row baseline | 999 independently blocked rows; one admitted canonical job; zero notification events |
| Same role on another source | Two open occurrences share one canonical job; no new event |
| Changed snapshot | One new internship creates one additional job and exactly one event |
| Duplicate actual queue message | Identical row, job, and event records after drain |
| Missing active immutable R2 object | Consumer records `snapshot-missing`; no new publication and no spent row attempt |
| Restored snapshot | Third job settles with exactly one additional event |
| Two complete omissions | Only the missing source occurrence closes; its peer keeps the job open |
| Policy migration | Every current row is independently re-evaluated without duplicate jobs or events |
| Legacy rollback | V2 admission/writer disabled; original legacy Poller resumes with stable canonical identities and event counts |

All controlled assertions passed. Rollback explicitly checks zero failures for
both legacy source polls, the three original canonical identities, identical
notification records, and exact public catalog membership. Legacy polling also
retains 50 unqualified fixture records; each has catalog and alert eligibility
false and remains absent from the public catalog. An earlier incomplete harness
result is retained separately and does not count as a rollback pass.

## Evidence locations

Normal cohort state, bootstrap previews, apply receipts, replay receipts, live
control checks, catalog reconciliation, and publication results:
`.context/verification/ingestion-v2/full-cutover/`.

Controlled phase receipts and runtime analytics: `.context/v2-controlled/`.
`experiment-state.json` names completed assertions and the current phase;
`runtime-proof.json` contains Cloudflare analytics and captured queue outcomes.
The latest consumer sample reports zero errors across 168 invocations,
64.1 MiB memory p99, and 0.27 seconds CPU p99. An initial driver self-fetch configuration failure preceded
source discovery and was fixed with a service binding.

The dedicated normal-dev R2 cron completed at 20:54 UTC. Independent verification
matched every published page and its aggregate hash to the exact durable D1
manifest, timestamp, and live watermark. A later successful read does not waive
a failed checkpoint; the soak must keep observing fresh scheduled publication.

Retain the controlled D1 and R2 state for independent inspection. Remove its
Workers and empty queues after proof capture so temporary scheduled work stops.
Keep normal dev running for the cohort and scheduled soak; resource warnings,
quarantine, durable drift, stale handoffs, and queue exhaustion all stop promotion.

## Lever reconciliation and admission memory repair

The dev gate found a Palantir new-grad occurrence admitted and open while its
canonical job was closed. Captured posting facts reproduce the system error:
the processor mistakes `Must be graduating in Fall 2026 or Spring 2027` for a
hiring season, then expires that season. Metadata projection also mistakes the
graduation dates for explicit role dates. Both parsers now exclude graduation
clauses while preserving independent role start dates. Genuine named hiring
seasons in descriptions retain explicit evidence; source defaults and bare years
remain inferred. Processor revision 4, metadata extraction version 19, and
evaluator revision 6 invalidate prior grading. The captured replay changes the
role to `ongoing`, open, and browsable while retaining its graduation window.
Regression coverage verifies creation and reopening remain quiet.

Admission batches now retain only selected postings after full immutable-board
validation, so provider awaits do not keep the rest of the board alive. Snapshot
normalization serializes duplicate candidates only for their deterministic
tie-break, and an existing R2 snapshot is validated before a replacement body is
serialized. Integrity validation and duplicate selection remain unchanged.

The production-shaped 25-row admission fixture retains about 3.7 MiB of extra
parsed-board heap in the prior implementation at the first provider await; the
repaired implementation retains no measurable extra board heap above the harness
baseline. A 2 MiB retention guard fails on the prior head and passes on the repair.
All eight resource-budget tests pass. These are local GC-backed measurements,
not a replacement for Cloudflare memory analytics or the clean dev soak gate.
