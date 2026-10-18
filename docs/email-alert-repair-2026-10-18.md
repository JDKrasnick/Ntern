# Operator alert repair, 2026-10-18 UTC

The screenshot identified production admission progress, Worker memory headroom,
destination-verification DLQ, and source-quarantine alerts. Investigation used
read-only D1/R2 inspection, serving-version analytics, retained watchdog reports,
and the authenticated operations API. Production served `cee898f5` throughout
the investigation; the code changes below are not a production release.

| Condition | Evidence and repair |
| --- | --- |
| Admission stalled | Watchdog run `39148636112` named two Rocket Lab rows. Their retained Greenhouse revisions preceded the official detail revisions. A source replay refreshed discovery; bounded pause/dispatch/resume then settled both rows as admitted at 17:26:53–54 UTC. Source ownership and the strict revision check remain intact. |
| Destination-verification DLQ | Live protected inspection returned zero messages; the unresolved failure ledger also returned zero rows. No messages were purged. |
| Paused quarantines | Egra still returned HTTP 404; Healthesystems returned an empty official jobs array. Both remain paused and were acknowledged again at 17:27:31–32 UTC. Automatic daily recovery probes had attempted these acknowledged sources again, causing another health email. Scheduled probes now respect acknowledged paused holds; explicit recovery remains available. A new open incident ignores an old acknowledgment timestamp. |
| Publisher memory | Serving publisher version `b4b97fa9-e792-45ee-9137-9f0ed3422c4e` reported 127.9 MiB p99 across the preceding 12 hours, with zero errors. Grouping eagerly built every featured role before releasing any raw groups. Publication now materializes one group at a time. |

The allocation regression uses 1,000 jobs with 30 source references each. Initial
summary allocation measured 6.07 MiB with the eager reference path and 0.35 MiB
with incremental materialization. The old path fails the 3 MiB regression limit.
Separate checks verify raw-job collection during and after materialization and
identical release, program, individual, and closed cards.

Production memory recovery still requires a guarded release followed by fresh
publisher cycles on the new serving version. A clean watchdog is point-in-time
health, not proof that memory spikes cannot recur. Future genuine Greenhouse
edits can also defer revision-bound admission until discovery catches up.
