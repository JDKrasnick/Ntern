# Independent ingestion email alerts

The ingestion Worker can fail before it sends its own support email. The
independent watchdog reads Cloudflare and durable state from GitHub Actions;
it never repairs sources, changes catalog decisions, or deploys Workers.

Cloudflare's native **InternNotifs Worker real-time issues** policy is enabled
for the existing operator inbox. It complements the existing usage-budget
notifications and the Worker’s own support alerts.

The **Ingestion watchdog and production cost gate** workflow checks production
and isolated dev at minutes 8, 28, and 48 each hour. The original cost audit
continues at minute 23. Scheduled executions use the default branch, so the
watchdog schedule becomes active only after this change lands on main. The
existing workflow can also be dispatched against a reviewed PR branch.

| Condition | Email trigger |
| --- | --- |
| Missed or failed scheduled work | Maintenance, D1 catalog, R2 catalog, or enabled V2 dispatch completion missing, invalid, failed, or over 30 minutes old |
| Broken catalog publication | Missing/retired R2 pointer outside the five-minute D1-to-R2 handoff; generation over 30 minutes old; corrupt/missing pages, hash, page map, or durable manifest; mismatch against a stable D1 generation |
| Public catalog failure | HTTP failure or a response without a catalog groups array |
| Worker failure | Any non-success invocation or recorded error on currently serving ingestion/admission/publisher versions in the last hour |
| Memory headroom | Current serving versions exceed 120 MiB at p99 in the last hour |
| Unresolved queue processing | A failure remains unresolved for at least 30 minutes, including destination verification; retry age never clears it |
| Active V2 source stops polling | Last attempt over one hour old, last success over two hours old, or missing/invalid timestamps |
| Admission stops progressing | Present quarantined rows; due queued rows unchanged for an hour; processing leases expired for 15 minutes; unacknowledged handoffs over 15 minutes old |
| Watchdog cannot inspect state | Missing credentials, lost API access, malformed required state, or probe timeout |

Paused and disabled sources are excluded from the active-owner progress checks.
Provider retry cooldowns are respected. Polling/progress checks apply only to
sources whose current flags authorize V2 catalog ownership. R2 inspection is
bounded to 10,000 groups, and source inspection to 50 owners, with a four-minute
overall probe deadline and 20-second request deadlines. Cloudflare analytics
may be sampled or delayed; durable completion markers provide a separate
signal for missed work.

Queue failure inspection samples the oldest 200 unresolved records using a
partial unresolved-state index. Reported queue counts describe that sample,
not total backlog. An incident stays active until a durable resolution receipt
clears it. Daily cleanup retains unresolved failures and keeps resolved receipts
for 30 days after resolution. Quarantined rows remain incidents until recovered or their source is
intentionally paused/disabled; rows retired by two complete omissions are excluded.

Emails use the existing private `AUTH_FROM_EMAIL` and
`ADMISSION_SUPPORT_RECIPIENT` environment secrets and the dedicated GitHub
environment secret `MONITOR_RESEND_API_KEY` in `cloudflare-workers-production`.
Never put their values in source, reports, or public logs. Each environment and
condition sends at most one email per six-hour window using Resend idempotency;
retry payloads stay identical. Healthy runs send no email. A rejected email
fails the job. Provider acceptance does not prove inbox delivery.

The email links to the workflow. Its retained artifacts contain timestamps and
incident counts; emails intentionally keep a stable body to avoid conflicting
idempotent retries. An incident makes the watchdog job fail **after** attempting
delivery. Download `ingestion-watchdog-production-*` or
`ingestion-watchdog-dev-*` artifacts for evidence (retained for 14 days).

Local read-only rehearsal:

```sh
WATCHDOG_ENVIRONMENT=dev node --env-file=.env --import tsx scripts/ingestion-watchdog.ts --dry-run
npx vitest run test/ingestion-watchdog.test.ts
```

Use `--test-email` only to deliberately verify the operator channel, with the
three private email environment variables configured. A GitHub runner/scheduler
outage can prevent this watchdog from executing or sending email; Cloudflare's
native policy is independent, but it does not prove that cron or this watchdog
executed. An external dead-man heartbeat service remains a separate future
improvement. Treat a missing workflow history as an investigation, not health.
