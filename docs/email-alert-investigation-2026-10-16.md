# Operator email investigation, 2026-10-16 UTC

Reviewed 68 delivered emails from the operator notification sender over the
preceding ten days: 24 production watchdog messages (including one delivery
test), 10 dev watchdog messages, and 34 Worker health messages. Evidence below
was checked against current main `4a5966ed`, retained Actions reports, read-only
D1 queries, Cloudflare analytics/logs, and live provider responses. Private email
headers, recipients, tokens, and account-linked details are excluded.

## Causes and disposition

| Alert | Evidence and cause | Action |
| --- | --- | --- |
| Scheduled work stalled | [Run 37990879867](https://github.com/JDKrasnick/intern-notifs/actions/runs/37990879867) reported admission dispatch `status=started, ageMinutes=3`. The watchdog required `complete` even during a healthy running phase. | Allow fresh starts; retain the last completion in the same durable marker so repeated starts cannot hide overdue completion. Failed markers still alert immediately. |
| Admission progress stalled | [Run 38833957743](https://github.com/JDKrasnick/intern-notifs/actions/runs/38833957743) named one Stripe row and one SpeedyApply AI row. Both were queued, lease-free, and had complete retained snapshots. A natural admission trace at 01:19 UTC processed only 24 sources in its one-minute budget, against 292 active source IDs. The rotating sweep delays due rows behind no-work and migration inspection. | Add an indexed, bounded work-first pass using half the existing budget; preserve time and cursor progress for the fleet sweep. |
| Workday row | The AI row retained `upstream-server-error`: “Workday published service-maintenance notice; posting remains unresolved.” A guarded dispatch at 01:23 UTC retried it and recorded another 15-minute cooldown. | Respect provider backoff and retain the row; do not mark an unresolved posting as admitted or gone. |
| Identity integrity / repeated source | Seven community sources appear repeatedly while coverage exceeds its ratcheted floor. Existing code labels the mere presence of that backlog a failed integrity audit and emails again on later days. The recurrence fix in draft [#438](https://github.com/JDKrasnick/intern-notifs/pull/438) had never reached main. | Bring recurrence inventory onto current main: seed the cohort once, alert on additions, and update only after successful delivery. Structural gates and coverage regressions remain enforced. Distinct cohorts on the same day use distinct delivery identities. |
| Source quarantined | Egra's Ashby endpoint currently returns 404. Healthesystems returns HTTP 200 with `jobs: []`, after previously listing one row. Both were already paused; repeated daily notifications did not indicate fresh failures. | Acknowledge both reviewed incidents through the operations API. Suppress unchanged acknowledged quarantines only while paused; another attempt after acknowledgment alerts again. Sources remain paused. |
| Worker errors, publication | Historical logs at 00:13:59 UTC contain `scheduled_step_failed`, step `catalog_projection`, error `D1_ERROR: Network connection lost.` The publisher rethrows other transient D1 classes but replaces this one with `D1 catalog projection failed`, yielding exceptions in both publisher and forwarding ingestion. | Preserve and defer the recognized retryable D1 class through the existing next-cadence protocol. Durable freshness checks continue to detect sustained failure. |
| D1 overload / failure ledger | Emails and logs show D1 overload at 05:12–06:18 UTC on October 15, plus older ledger-write failure markers. The marker has a 24-hour reporting lifetime. Current production and dev have no unresolved queue-failure records. | Keep pressure and ledger alerts enabled. Recovered history is not evidence of a present incident; no queue messages or incidents were purged. |
| Polling / cadence slips | October 14's watchdog identified seven Ashby sources; earlier cadence emails include a 94-source Greenhouse slip. Current polling and completion probes recover. | Retain cadence thresholds. The retrieved historical reports do not alone establish the cause of every earlier delay. |
| Memory headroom | October 14 dev analytics attribute 125.8 MiB p99 at 19:00 UTC to catalog-publisher version `1d02b90f-fefc-4a8f-854d-b746d3532b56`; other hours on that version also exceed the threshold. | Keep the 120 MiB warning. Current dev watchdog is clean, but this investigation does not establish a memory allocation fix. |

## Live actions and remaining work

The authenticated pause/dispatch/resume flow sent one existing row for each of
`greenhouse-stripe` and `speedyapply-2027-ai`, then restored both to active.
Stripe row `8248509` reached a terminal blocked decision through the normal
evaluator. The Workday row remains unresolved with a fresh retry cooldown.
The two reviewed quarantines were acknowledged and remain paused.

After those actions, read-only production and dev watchdog runs both returned
zero signals. This is a point-in-time result, not deployment evidence for this
patch. Code changes and migration `0056` need the guarded release path and a
natural-run observation before claiming reduced production latency or email
volume. The acknowledgment suppression also requires that deployment.

Historical logs additionally contain handled provider timeouts, a browser
connection closure, D1 traffic-observer internal failures, and Gmail refresh
HTTP 400 responses. The available error records do not prove a single cause for
every historical invocation failure. Persistent Gmail authorization errors need
the affected account's reconnection flow; credentials were not changed.

## Validation

Regression coverage exercises real SQLite dispatch selection and its index,
cooldowns/omissions/leases, dispatch time budgets and cursor fairness, retention
of last completion across repeated starts, recurrence delivery failures,
same-day distinct cohorts, acknowledged quarantines, and transient publication
deferral followed by recovery. Full-suite and build results are recorded in the
PR: 3,461 tests passed, 314 skipped (199 files passed, five skipped); TypeScript,
lint on changed TypeScript files, and all four Worker dry-run bundles passed.
No Worker code was deployed during this investigation.
