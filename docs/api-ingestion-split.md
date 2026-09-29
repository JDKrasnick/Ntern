# API and ingestion Worker split

The public API stays `intern-notifs`. The private ingestion Worker is
`intern-notifs-ingestion`; it has no `workers.dev` or preview URL and is reached
only through the API Worker's `INGESTION` service binding. Both Workers use the
same existing D1 database and existing queues. This is a deployment-boundary
change, not a catalog-policy or schema change.

## Ownership inventory

| Surface | Owner after cutover | Notes |
| --- | --- | --- |
| Public catalog, filters, releases, application tracking, account/auth, installations, résumés, employer APIs, Gmail OAuth callback/API | API Worker | Existing hostname and request paths remain unchanged. |
| `/operations/*`, `/internal/operations/*`, admission, DLQ, backfill, poll-source, catalog-quality, notification recovery, projection refresh, posting-identity repair | Ingestion Worker, forwarded by API Worker | The API checks nothing new for these routes; the existing operations key remains required by the destination handler. A second secret authenticates the API-to-ingestion hop. |
| Billing shutdown webhook | Ingestion Worker, forwarded by API Worker | Existing webhook path and its separate webhook secret remain unchanged. |
| Every cron | Ingestion Worker only | `*/5`, GitHub, provider, hourly, daily maintenance, identity-audit, company-icon, and catalog-projection schedules are declared only in `wrangler.ingestion.jsonc`. |
| All seven queue consumers and DLQs | Ingestion Worker only | Greenhouse, Lever, Ashby, GitHub, Gmail, destination verification, and shadow extraction. |
| Request-triggered Gmail checks | API Worker producer | The API retains only the Gmail producer because applying to a role can enqueue delayed checks. |

The API config needs D1, private R2 documents, Gmail producer, auth/email and
Gmail secrets, `OPERATIONS_SHARED_SECRET`, and `INTERNAL_SERVICE_SECRET`. The
ingestion config needs D1, Browser Rendering, every queue producer/consumer,
ingestion/email/Gmail/operations/billing secrets, and the same
`INTERNAL_SERVICE_SECRET`. Do not put either secret in Wrangler config, Git,
logs, shell arguments, or `EXPO_PUBLIC_*`; set it interactively from the
approved secret manager for each Worker.

## Local end-to-end harness

Run the reusable two-Worker harness before a cutover or after changing the
route boundary, service binding, authentication headers, or either entrypoint:

```bash
npm ci
npm run test:e2e
```

The command builds the same API and ingestion bundles used by deployment, runs
them as separate services in one ephemeral local `workerd` process, applies all
checked-in D1 migrations, and sends requests through the real `INGESTION`
service binding. It uses fixed test-only secrets, requires no Cloudflare account
or credentials, and leaves no persistent database or Worker state behind.

## Secret inventory

The two Workers intentionally share several secret values, but each secret is
stored independently on each Worker. Retrieve shared values from the approved
secret manager and enter the same value at both interactive prompts. Never put
secret values in shell arguments, committed files, or `EXPO_PUBLIC_*` variables.

API Worker secrets:

```bash
npx wrangler secret put AUTH_SESSION_SECRET --config wrangler.api.jsonc
npx wrangler secret put OPERATIONS_SHARED_SECRET --config wrangler.api.jsonc
npx wrangler secret put RESEND_API_KEY --config wrangler.api.jsonc
npx wrangler secret put GMAIL_CLIENT_SECRET --config wrangler.api.jsonc
npx wrangler secret put GMAIL_TOKEN_ENCRYPTION_KEY --config wrangler.api.jsonc
npx wrangler secret put GMAIL_MESSAGE_HMAC_KEY --config wrangler.api.jsonc
npx wrangler secret put INTERNAL_SERVICE_SECRET --config wrangler.api.jsonc
```

Ingestion Worker secrets:

```bash
npx wrangler secret put OPERATIONS_SHARED_SECRET --config wrangler.ingestion.jsonc
npx wrangler secret put RESEND_API_KEY --config wrangler.ingestion.jsonc
npx wrangler secret put GMAIL_CLIENT_SECRET --config wrangler.ingestion.jsonc
npx wrangler secret put GMAIL_TOKEN_ENCRYPTION_KEY --config wrangler.ingestion.jsonc
npx wrangler secret put GMAIL_MESSAGE_HMAC_KEY --config wrangler.ingestion.jsonc
npx wrangler secret put INTERNAL_SERVICE_SECRET --config wrangler.ingestion.jsonc
npx wrangler secret put BILLING_WEBHOOK_SECRET --config wrangler.ingestion.jsonc
npx wrangler secret put CLOUDFLARE_SHUTDOWN_TOKEN --config wrangler.ingestion.jsonc
```

Set `ADMISSION_SUPPORT_RECIPIENT` on ingestion with the same command shape when
admission-support email is enabled. The API-only `AUTH_SESSION_SECRET`, all six
shared secrets, and the billing-only ingestion secrets must exist before the
full cutover plan is applied.

## Controlled cutover

Only the coordinator performs this procedure. No migration, queue replay,
purge, reset, or historical repair is part of it.

1. Record the API Worker version, all current queue consumers, cron ownership,
   queue/DLQ depths, `GET /operations/sources` response, public `/jobs` and a
   filtered catalog response. Record the exact API and ingestion build SHAs.
2. Build both bundles. The existing destination-verification queue and DLQ
   predate their Terraform ownership entries, so import both before any plan:

   ```bash
   npm run build:cloudflare
   tofu -chdir=infra/cloudflare import \
     'cloudflare_queue.work["destination-verification"]' \
     "${TF_VAR_cloudflare_account_id}/9b48a594d06a441e8b8ed45de0c430af"
   tofu -chdir=infra/cloudflare import \
     'cloudflare_queue.dead_letter["destination-verification"]' \
     "${TF_VAR_cloudflare_account_id}/2b7435186d9741e29e720c43ec068c87"
   ```

   Confirm a refresh-only plan has no other unmanaged queue.
3. Create a temporary shell configuration that cannot claim a trigger or
   consumer, deploy it, and immediately import the new script and disabled
   subdomain into OpenTofu state:

   ```bash
   jq 'del(.queues.consumers, .triggers)
     | .queues.producers |= map(select(.queue != "intern-notifs-shadow-extraction" and .queue != "intern-notifs-shadow-extraction-dlq"))
     | .r2_buckets |= map(select(.binding != "SHADOW_EXTRACTION_ARTIFACTS"))
     | .main = "../cloudflare/ingestion-worker.ts"
     | ."$schema" = "../node_modules/wrangler/config-schema.json"
     | .d1_databases[0].migrations_dir = "../cloudflare/migrations"' \
     wrangler.ingestion.jsonc > .context/wrangler.ingestion-shell.jsonc
   npx wrangler deploy --config .context/wrangler.ingestion-shell.jsonc
   tofu -chdir=infra/cloudflare import cloudflare_workers_script.ingestion \
     "${TF_VAR_cloudflare_account_id}/intern-notifs-ingestion"
   tofu -chdir=infra/cloudflare import cloudflare_workers_script_subdomain.ingestion \
     "${TF_VAR_cloudflare_account_id}/intern-notifs-ingestion"
   ```

   Confirm `workers_dev=false`, previews are disabled, and the new Worker owns
   no cron or queue consumer. The temporary configuration stays under the
   gitignored `.context/` directory and is not reused after this step.
4. Set the secrets from the inventory above. Generate one new
   `INTERNAL_SERVICE_SECRET` and enter the same value for both Workers.
5. Create a temporary API cutover configuration with an explicit empty cron
   list. Remove each old consumer explicitly before deploying it: Wrangler does
   not remove consumers merely because they are absent from a deployment
   configuration, and Cloudflare rejects the handler-less API bundle while an
   old consumer still targets it. Then deploy the API configuration to preserve
   the public hostname, activate the service binding, and clear all nine old
   schedules:

   ```bash
   jq '.triggers = { "crons": [] }
     | .main = "../cloudflare/api-worker.ts"
     | ."$schema" = "../node_modules/wrangler/config-schema.json"
     | .d1_databases[0].migrations_dir = "../cloudflare/migrations"' \
     wrangler.api.jsonc > .context/wrangler.api-cutover.jsonc
   npx wrangler queues consumer remove intern-notifs-greenhouse intern-notifs --config wrangler.api.jsonc
   npx wrangler queues consumer remove intern-notifs-lever intern-notifs --config wrangler.api.jsonc
   npx wrangler queues consumer remove intern-notifs-ashby intern-notifs --config wrangler.api.jsonc
   npx wrangler queues consumer remove intern-notifs-github intern-notifs --config wrangler.api.jsonc
   npx wrangler queues consumer remove intern-notifs-gmail intern-notifs --config wrangler.api.jsonc
   npx wrangler queues consumer remove intern-notifs-destination-verification intern-notifs --config wrangler.api.jsonc
   npx wrangler deploy --config .context/wrangler.api-cutover.jsonc
   ```

   Confirm there are exactly zero active consumer and schedule owners before
   continuing. Queue consumers cannot be imported by the provider, and changing
   the cron resource's state address does not clear schedules on its former
   Worker, so this explicit zero-owner step is required. Do not trigger
   backfills or replays during the pause.
6. Create and inspect the full OpenTofu plan. The checked-in `moved` blocks
   transfer the existing consumer and cron state addresses from `application`
   to `ingestion`; they prevent OpenTofu from treating the address rename as a
   second independent fleet. Because step 5 removed the live old ownership,
   the plan must attach consumers and schedules only to
   `intern-notifs-ingestion`; reject any plan that targets the API Worker for a
   consumer or cron.

   ```bash
   tofu -chdir=infra/cloudflare plan -out=../../.context/ingestion-cutover.tfplan
   tofu -chdir=infra/cloudflare apply ../../.context/ingestion-cutover.tfplan
   ```

   Confirm each of the seven queues has exactly one ingestion consumer, all nine
   crons belong only to `intern-notifs-ingestion`, and the API service binding
   resolves. Run a second plan and require no changes before considering the
   state transition complete.
7. Run the smoke checks below before enabling any optional policy or repair
   work. Keep the deployment versions and queue-owner evidence with the release
   record.

After the controlled shell deployments, never deploy either full Wrangler
configuration alongside the OpenTofu-managed scripts. That bypasses the
recorded state transition and can duplicate schedules, consumers, and
notifications.

## Smoke checks

With `OPERATIONS_SHARED_SECRET` supplied only through the coordinator's secure
environment, verify:

```bash
curl -fsS https://intern-notifs.jdkrasnick.workers.dev/jobs
curl -fsS 'https://intern-notifs.jdkrasnick.workers.dev/catalog?disciplines=Software%20Engineering'
curl -fsS -H "X-Operations-Key: $OPERATIONS_SHARED_SECRET" \
  https://intern-notifs.jdkrasnick.workers.dev/operations/sources
curl -fsS -H "X-Operations-Key: $OPERATIONS_SHARED_SECRET" \
  https://intern-notifs.jdkrasnick.workers.dev/internal/deployment
```

Also confirm an unauthenticated `/me/*` request remains unauthorized, a
private document remains unavailable without its owner session, operations
without the key return the preexisting hidden response, and the filtered result
does not expand to roles outside the requested filter. The deployment endpoint
reports the API and ingestion roles; record the platform deployment IDs from
the deploy output alongside it.

## Rollback

The rollback is code/configuration-only: D1 and queues remain untouched.

1. Pause the ingestion cron and queue consumers; wait for the single active
   batch to complete or retry naturally. Do not purge or replay queues.
2. Restore the prior API version/configuration (including the original queue
   consumers and cron ownership) only after confirming ingestion owns none.
3. Confirm exactly one owner per queue and cron, then repeat the smoke checks
   and compare public catalog, filter, source-health, outbox, and queue/DLQ
   counts to the recorded baseline.

If the API version is healthy but only the internal forwarding fails, leave
ingestion paused and restore the prior API configuration. Do not roll back or
alter shared D1 schema as part of this procedure.
