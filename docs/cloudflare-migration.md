# Cloudflare migration runbook

## Status and invariants

Cloudflare is the only backend. EAS development, preview, and production
environments target its Worker (verified September 6, 2026). Existing native
binaries need a new approved build to pick up changed build-time values. People
who want account-backed data create a verified email/password account; browsing
and device alerts need none.

The migration preserves these product rules:

- the catalog remains public;
- anonymous installations own push alerts and settings; accounts are required only for profiles, documents, and synced application tracking;
- employer applications still hand off to the official form;
- private documents remain accessible only to their owner;
- source admission, reconciliation, notification, and operator-control behavior remains provider-neutral.

## Service mapping

| AWS implementation | Cloudflare replacement |
| --- | --- |
| API Gateway + Lambda | Workers fetch handler |
| Cognito | D1-backed verified email/password accounts and opaque sessions |
| DynamoDB catalog and user tables | D1 indexed JSON records |
| S3 applicant documents | Private R2 bucket served through authenticated Worker routes |
| FIFO SQS and dead-letter queues | Four provider/source Queues with per-source idempotent checkpoints and DLQs |
| EventBridge Scheduler | Workers Cron Triggers |
| CloudWatch application state | Workers observability plus durable D1 source health |
| SSM and Secrets Manager | Worker secret bindings |
| SES | Resend for verification and optional owner digest email |
| CDK | Cloudflare provider v5 Terraform in `infra/cloudflare/` |

Cloudflare Queues do not promise SQS FIFO message-group semantics. The provider
workers therefore keep the existing source-level checkpoints, deterministic
outbox IDs, and idempotent upserts as the correctness boundary.

The ingestion Worker requires the Workers Paid plan: source polls can exceed
the free plan's CPU and subrequest ceilings. D1 has a hard 10 GB size per paid
database, so storage growth must be monitored before public scale; the daily
catalog retention sweep bounds the append-only history (see
[`catalog-storage-retention.md`](catalog-storage-retention.md)).

## Local verification

```bash
npm ci
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run cloudflare:migrate:local
cp .dev.vars.example .dev.vars
npx wrangler dev --local --config wrangler.api.jsonc
```

Use throwaway local values in `.dev.vars`. The file is ignored. Wrangler can
also read the repository `.env`; never place AWS credentials or production
secrets in Worker variables.

`npm run test:e2e` compiles both Worker entrypoints and starts them as separate
services in an ephemeral local `workerd` process. The harness applies the
checked-in D1 migrations, exercises the real `INGESTION` service binding, and
uses test-only secrets. It does not contact or mutate Cloudflare resources.
When Docker is unavailable, the command automatically uses Wrangler's
`--containers-rollout=none` mode for these local dry-run bundles. Deployment
builds still use the complete container build.

## Provision infrastructure

Create a scoped Cloudflare API token with account permissions for Workers
Scripts, D1, R2, Queues, and Workers Tail/observability. Add Zone/DNS edit only
when Terraform will attach a custom API hostname.

```bash
export CLOUDFLARE_API_TOKEN='set-in-your-shell-or-secret-manager'
export TF_VAR_cloudflare_account_id='cloudflare-account-id'
export TF_VAR_public_api_url='https://api.example.com'
export TF_VAR_api_hostname='api.example.com'
export TF_VAR_zone_id='cloudflare-zone-id'

npm run build:cloudflare
tofu -chdir=infra/cloudflare init
tofu -chdir=infra/cloudflare plan -out=../../.context/cloudflare.tfplan
tofu -chdir=infra/cloudflare apply ../../.context/cloudflare.tfplan
```

Do not put the token, account identifiers, email addresses, or secret values in
committed `.tfvars`. Configure a remote encrypted Terraform backend before a
second operator or CI starts applying infrastructure.

## Initialize D1 and secrets

After apply, update the D1 identifier in both explicit Worker configurations
only when provisioning a new database, then apply `cloudflare/migrations/` with
`wrangler.api.jsonc`. Do not restore a shared default `wrangler.jsonc`.

Apply every pending D1 migration before deploying Worker code that depends on
its schema. In particular, migration `0005_auth_consent.sql` must land before
the consent-aware signup handler. With the temporary remote configuration:

```bash
npx wrangler d1 migrations apply intern-notifs-db --remote \
  --config wrangler.api.jsonc
npm run build:cloudflare
tofu -chdir=infra/cloudflare plan -out=../../.context/cloudflare.tfplan
tofu -chdir=infra/cloudflare apply ../../.context/cloudflare.tfplan
```

Review the migration list and Terraform plan before applying either one. Never
deploy the Worker first: the new signup query requires the consent columns.

Create separate random secrets for user sessions and operator access:

```bash
npx wrangler secret put AUTH_SESSION_SECRET --name intern-notifs --config wrangler.api.jsonc
npx wrangler secret put OPERATIONS_SHARED_SECRET --name intern-notifs --config wrangler.api.jsonc
npx wrangler secret put RESEND_API_KEY --name intern-notifs --config wrangler.api.jsonc
```

Before the API/ingestion split cutover, configure the complete per-Worker
secret inventory in [`api-ingestion-split.md`](api-ingestion-split.md). Several
values are required on both Workers; the API-only commands above are not a
complete split deployment.

Set `auth_dev_mode=false` before any non-development deployment. `true` returns
the email confirmation code in the signup response and is intentionally local/dev
only. `AUTH_FROM_EMAIL` must be a sender verified by the configured mail service.

## Cost guards

Cloudflare budget alerts are informational and are not hard spending limits.
The Worker therefore keeps its paid-plan blast radius deliberately small:

- 120,000 ms of CPU and 50,000 subrequests per ingestion invocation, preserving
  the production envelope for bounded oversized-provider detail slices; Cloudflare does not bill subrequests,
  and the paid plan's included CPU allocation remains the account-level guard;
- one queued source job at a time, with batches of one and two retries;
- five private documents per user and 100 documents account-wide;
- 5 MiB per document and 1,000 R2 uploads per UTC calendar month.

These application limits do not cap billable inbound Worker requests. Keep the
account-wide $1, $3, and $5 budget alerts enabled and investigate the first
warning rather than waiting for the billing cycle to close.

An independent GitHub workflow, `cloudflare-budget-guard.yml`, runs every ten
minutes. It reads the account-wide bill feed and measured D1 writes across all
databases, including dev. It replaces the delayed D1 write charge with a
conservative estimate from the measured billing-cycle total and the shared
50-million-row allowance. The separate rolling-hour limit defaults to 60,000
billed writes across the account; it is not a per-source estimate.

The usage ceiling defaults to the existing **$5** shutdown policy. The
`CLOUDFLARE_USAGE_BUDGET_DOLLARS` and `CLOUDFLARE_D1_WRITES_PER_HOUR` repository
variables can set reviewed limits. Subscription fees and external model-provider
charges are outside this usage ceiling. Changing a notification threshold does
not change these workflow limits. A cost estimate is not approval to raise them.

The guard is read-only unless invoked with `--enforce`; its scheduled workflow
uses enforcement. A breached limit or unavailable billing/analytics telemetry
latches both production and dev, removes their queue consumers, and clears their
Worker schedules. It verifies the latches, cleared schedules, and empty consumer
lists, retaining a report even when an individual operation fails. It preserves
stored data and does not purge queues. In-flight discovery and admission
messages retry after an hour instead of being acknowledged without processing;
queue retention and dead-letter limits still apply. Management credentials need D1 read/write,
Workers Scripts read/write, Queues read/write, Billing read, and Analytics read.
The webhook shutdown credential also needs management access to both databases.

This is a periodically enforced control, not an exact provider-side spending
cap: GitHub scheduling and Cloudflare analytics can lag, and in-flight work can
finish after a pause. Non-D1 product usage still comes from the daily billing
feed. Keep Cloudflare notifications enabled as an independent signal.

The $5 alert also targets a generic webhook at
`/internal/billing-shutdown`. Cloudflare authenticates it with the
`cf-webhook-auth` header. The API Worker forwards the authenticated webhook to
the ingestion Worker, which latches `billing_shutdown=stopped` in its D1 binding
**before** resource discovery, then invokes the same production-and-dev shutdown
procedure. A failed management operation does not prevent the remaining stop
actions; an incomplete shutdown returns 503 and identifies failed operations.
The public API Worker remains routed
but returns the latched 503 response. The D1 latch makes scheduled, queued, and
HTTP work fail closed even if a management API call is delayed. Test webhook
payloads are ignored; shutdown requires the signed `billing_budget_alert`
payload for the named $5 policy and account.

Ordinary production deploys and the dev preflight refuse to restore processing
while the billing latch is set. Recovery therefore requires an explicitly
reviewed recovery plan: verify the cause and the current account budget, agree
which environment may run, deliberately clear only that environment's latch as
part of the reviewed recovery, then restore its consumers and schedules through
the guarded infrastructure workflow.
The provider does not reliably detect an externally emptied cron list, so the
plan must account for schedules as well as consumers. Verify exact ownership,
the actual account guard, and durable catalog progress before declaring recovery
complete. No workflow automatically clears a billing latch.

Deployments check the environment's durable billing latch before each deployment
phase and after the command exits, including command failure. If a shutdown
arrives while a command is already restoring resources, deployment reasserts the
latch, removes that environment's consumers, clears its schedules, verifies the
result, and fails. An unavailable final latch read also fails closed. Production
workflow mutation steps and the local deployment commands use this same guard;
the workflow also reconciles shutdown after failure or cancellation. The command
guard stops its child process group on cancellation before reconciling resources.
Dev cleanup targets only dev; it never pauses production as a side effect.
This is compensation for in-flight management requests, not an atomic Cloudflare
transaction, and a killed runner cannot guarantee cleanup. The independent
account guard remains the backstop. Use the guarded npm commands rather than
invoking individual Wrangler commands during deployment.

Terraform deliberately keeps Worker secret bindings; recovery does not require
rotating the shutdown credentials.

## Release verification

The public catalog projection is written to D1 and mirrored under
`public-catalog/v1/` in the private documents R2 bucket. The API reads the
complete R2 version after its pointer is published, and falls back to D1 if
the R2 version is missing or damaged. Compare the R2 pointer's hash, generated
time, and group count with D1 before enabling `CATALOG_R2_READ_ENABLED` in
production. A prefix-scoped `catalog-projection-14d` lifecycle rule expires old
immutable pages in both `intern-notifs-documents` and
`intern-notifs-dev-documents`; check it with
`npx wrangler r2 bucket lifecycle list <bucket>` after bucket changes. The
current pointer is refreshed every ten minutes, while readers accept a
complete projection for up to seven days if maintenance is interrupted.

Both pointers also carry the watermark of the newest open role their publish
observed. A role ingested since then is grouped on the read path and led ahead
of the page (see the decisions log for 2026-10-02), so a catalog page is the
snapshot plus that live head: an R2-served read probes the D1 delta with the
pointer's watermark before serving, which is one indexed range query that
returns nothing in the ordinary current state.

Before changing the mobile build, verify public catalog paging, sign-up and
verification, sign-in, account deletion, notification registration, R2 document
upload/download, all four catalog-provider queues and DLQs, Cron events, and operations
replay against the deployed Worker.

Set `EXPO_PUBLIC_API_URL` to the Cloudflare hostname and produce a test build.
Rollback uses the prior verified Cloudflare Worker deployment and OpenTofu state;
it never changes the app's API to a different provider.

## Recover notification markers consumed before device registration

The notification drain leaves jobs pending while D1 has no user with both an
active Expo device and completed, enabled alert preferences. If an older Worker
already consumed markers without creating a delivery receipt, use the guarded
operations endpoint after deploying the fix and completing the physical-device
alert check.

First preview one bounded batch. Keep the shared secret in the shell and out of
history, logs, and source control:

```bash
read -s OPERATIONS_SHARED_SECRET
RECOVERY_SINCE="$(node -p 'new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()')"
curl --fail-with-body --silent --show-error \
  -H "X-Operations-Key: $OPERATIONS_SHARED_SECRET" \
  -H 'Content-Type: application/json' \
  -d "{\"since\":\"$RECOVERY_SINCE\",\"limit\":10}" \
  https://intern-notifs.jdkrasnick.workers.dev/internal/recover-notifications
unset OPERATIONS_SHARED_SECRET RECOVERY_SINCE
```

The preview returns `candidates` plus the ordered `candidateJobIds` array and
changes nothing. Re-run the same request with `"apply":true` and
`"expectedCandidateJobIds":<the exact preview array>` only after confirming at
least one opted-in physical device is registered. The operation requeues only
open jobs that have a durable notification event and no delivery receipt for
any device; the exact-ID guard rejects a changed candidate set even if its size
is unchanged. Use small batches to avoid a burst of old alerts, and preview
again before each batch until it returns zero.
The endpoint rejects a `since` value older than the notification event's 30-day
retention window and returns `earliestSupportedSince`; this prevents a preview
from appearing complete after older outbox rows have already been deleted.

### Migrate legacy account-owned mobile alerts

The first signed-in launch after this release checks for a legacy account alert
preference. If the installation already has alerts, it only retires the legacy
flag. Otherwise, on a physical device with notification permission, the client
registers that device's current Expo token to its anonymous installation,
copies the legacy filter and alert settings, and only then disables the retired
account alert flag. Every step is idempotent, and a failed attempt leaves the
account flag in place for a later launch. Do not move device rows between users
manually: an installation observed in D1 may belong to a simulator or a
different device.
