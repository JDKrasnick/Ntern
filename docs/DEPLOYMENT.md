# Deployment and operations runbook

> Cloudflare is the only backend. The Worker and Terraform configuration are
> documented in [`cloudflare-migration.md`](cloudflare-migration.md).

## Architecture

InternNotifs is an Expo mobile app with a Cloudflare Worker backend.

| Area | Service / implementation |
| --- | --- |
| Mobile | Expo SDK 55, React Native, iOS first; `mobile/` |
| Authentication | D1-backed verified email/password accounts and opaque sessions |
| Public catalog API | Cloudflare Worker |
| Private user API | Opaque-session-authorized `/me/*` Worker routes |
| Job catalog | D1 indexed canonical records and grouped projections |
| Personal data | D1 user records and releases |
| Résumés | Private R2 objects behind authenticated Worker routes |
| Ingestion, delivery, and Gmail sync | Cron Triggers, seven Queues with DLQs, Worker consumers, Gmail read-only API, Expo Push Service |
| Infrastructure | OpenTofu with Cloudflare provider v5 in `infra/cloudflare/` |
| CI | GitHub Actions in `.github/workflows/ci.yml` |

The catalog is public. Accounts, preferences, device tokens, profiles, documents, and application tracking are private to the verified user identity.

## Required Cloudflare development gate

Every backend change must be deployed and smoke-tested in the isolated Cloudflare
development environment before a production deployment is considered. The
development Workers are `intern-notifs-dev` and `intern-notifs-dev-ingestion`;
their public API is `https://intern-notifs-dev.jdkrasnick.workers.dev`.

The development stack has its own D1 database (`intern-notifs-dev-db`), R2
buckets, queues, Durable Object namespace, and Worker secrets. It must never
bind a production database, bucket, queue, service, or secret. Its ingestion
configuration intentionally has no cron triggers, so testing cannot begin
provider polling or alter the production catalog.

Use the committed, config-specific commands—never a bare Wrangler deploy:

```sh
npm run build:cloudflare
npm run cloudflare:dev:provision
npx wrangler d1 migrations apply intern-notifs-dev-db --remote --config wrangler.dev.api.jsonc
npx wrangler deploy --config wrangler.dev.ingestion.jsonc
npx wrangler deploy --config wrangler.dev.api.jsonc
curl -fsS 'https://intern-notifs-dev.jdkrasnick.workers.dev/catalog?limit=5'
```

Verify the public catalog, authentication lifecycle, and protected operations
boundary there. A successful development run is a prerequisite for, but never
authorization to perform, a production deploy.

## API and ingestion deployment boundary

The API Worker and ingestion Worker have separate, explicit Wrangler
configurations. Use `npm run build:cloudflare` to validate both; do not run a
bare `wrangler deploy`. The cutover sequence, binding inventory, smoke checks,
and rollback procedure are in [`api-ingestion-split.md`](api-ingestion-split.md).
The coordinator alone performs that cutover.

### Resume Tuner staged rollout

`RESUME_TUNER_ENABLED` is `false` in both Worker configs and must remain false
until a separate security review approves an exact OpenTofu plan. The feature
uses authenticated `/me/resume-*` routes, private user-store records, and the
`intern-notifs-resume-job-import` queue. Its shared import cache contains only
public job-page text; uploaded résumé source material, extracted bank cards,
drafts, and generated artifacts remain user-scoped and are deleted with the
account.

The résumé API also stores a provider-neutral subscription entitlement and a
UTC monthly usage counter in the same account-scoped D1 table. Paid upgrades
must remain unavailable until App Store products, server-side transaction
verification, App Store Server Notifications, restore-purchase behavior, and
sandbox acceptance are complete. Never write an entitlement from an
unverified mobile request. Accounts without an active or grace-period verified
entitlement receive the Free allowance of two new tailored reviews per month.

The production workflow idempotently provisions the
`intern-notifs-resume-bank-v1` Vectorize index with the
`@cf/baai/bge-base-en-v1.5` preset before OpenTofu binds it. The API uses
Vectorize's built-in namespace partition instead of metadata filters, so no
metadata index is required. It stores no raw account ID or résumé text in
Vectorize metadata: the namespace is a stable account hash and vectors remain a
delete-on-account-removal cache. Confirm the index name and its 768-dimension
cosine configuration match `resume_embedding_index_name` before approving the
exact OpenTofu plan.

Validate the API and ingestion Worker bindings, exercise a catalog hit, a
cached import, a safe public-page import, Browser Rendering, and the
manual-description fallback. Confirm that private-network, credential-bearing,
and non-HTTPS URLs are rejected; check the import queue and its DLQ without
consuming messages. Compile a fixture through the internet-disabled Container
and inspect the bounded PDF, TeX, page-count metadata, and private PNG previews.
Account deletion must remove every one of those R2 objects and the associated
Vectorize IDs before the flag can be enabled.

## OpenTofu state adoption

The production Cloudflare stack uses the private
`intern-notifs-opentofu-state` R2 bucket and the
`production/cloudflare.tfstate` object. The bucket is intentionally outside the
managed stack so destroying or replacing application resources cannot destroy
their state backend. Bootstrap it once with Wrangler or the Cloudflare API, then
create an R2 token scoped only to that bucket with Object Read & Write access.
Do not put the R2 access key, secret key, backend endpoint, state, or saved plan
in Git.

The `Deploy Cloudflare Workers` workflow runs after a successful `CI` push run
on `main`; it can also recover a deployment through a manual dispatch for the
exact green SHA at the tip of `main`. The `cloudflare-workers-production`
environment supplies the Cloudflare token, bucket-scoped state credentials,
and live non-secret Terraform variables. The job rejects obsolete revisions
and any plan containing creates, deletes, replacements, or updates outside the
two Worker scripts. It applies the exact saved plan, requires a no-drift second
plan, then performs the one supported container-specific deployment step: a
full API Wrangler deploy builds, publishes, and rolls out the résumé PDF
compiler image. That step uses a generated config without `vars` plus
`--keep-vars`, so OpenTofu-managed production values remain authoritative. It
then monitors public and authentication-boundary smoke checks for two minutes.
Keep environment approval rules enabled when a human deployment gate is
required. Do not run the container deploy separately or with the committed
config's staged flag values.

Configure these environment secrets: `CLOUDFLARE_API_TOKEN`,
`R2_STATE_ACCESS_KEY_ID`, and `R2_STATE_SECRET_ACCESS_KEY`. The optional
`OPERATIONS_SHARED_SECRET` enables the authenticated deployment-ID smoke check.
Keep the live values for `CLOUDFLARE_ACCOUNT_ID`, `PUBLIC_API_URL`,
`EMPLOYER_PORTAL_ENABLED`, `AUTH_FROM_EMAIL`, `GMAIL_ENABLED`,
`GMAIL_CLIENT_ID`, `GMAIL_REDIRECT_URI`,
`IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED`,
`TRUSTED_COMMUNITY_CATALOG_ENABLED`, `IDENTITY_CONFIRMED_COVERAGE_FLOOR`,
`LLM_METADATA_PUBLICATION_POLICY_JSON`, `SHADOW_EXTRACTION_ENABLED`,
`SHADOW_EXTRACTION_MONTHLY_FORECAST_CENTS`, and
`SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS` as environment variables. Saved
plans and before/after state backups remain in the private state bucket under
`production-deployments/DEPLOY_SHA/GITHUB_RUN_ID/`; never upload them as public
workflow artifacts.

Supply the Cloudflare R2 S3-compatible endpoint and bucket-scoped credentials
through the operator environment. OpenTofu uses `AWS_*` variable names solely
because its R2 state backend is S3-compatible; these are Cloudflare R2
credentials, not credentials for another cloud provider. Use a dedicated
shell so the S3-compatible variable names are not mistaken for AWS access:

```bash
export AWS_ACCESS_KEY_ID='bucket-scoped R2 access key ID'
export AWS_SECRET_ACCESS_KEY='bucket-scoped R2 secret access key'
export AWS_ENDPOINT_URL_S3='https://CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com'
export AWS_REGION='auto'
tofu -chdir=infra/cloudflare init -reconfigure
```

State adoption is deployment-phase-sensitive. During the API/ingestion split,
follow the serialized imports in [`api-ingestion-split.md`](api-ingestion-split.md)
instead of bootstrapping the steady-state configuration directly. An existing
pre-split state keeps `cloudflare_workers_cron_trigger.application` and
`cloudflare_queue_consumer.application` until the checked-in `moved` blocks
transfer them during that cutover; do not re-import those old addresses from
the post-split configuration.

For a fresh adoption after the split is complete, import every existing
production resource at its current address. This includes
`cloudflare_d1_database.application`, `cloudflare_r2_bucket.documents`, both
`cloudflare_workers_script.application` and
`cloudflare_workers_script.ingestion`, both
`cloudflare_workers_script_subdomain.application` and
`cloudflare_workers_script_subdomain.ingestion`,
`cloudflare_workers_custom_domain.api[0]` when configured,
`cloudflare_workers_cron_trigger.ingestion`, and all keys in
`cloudflare_queue.work` and `cloudflare_queue.dead_letter`: `greenhouse`,
`lever`, `ashby`, `github`, `gmail`, `destination-verification`, and
`shadow-extraction`. Queue consumers cannot be imported by provider v5; first
confirm that no old Worker owns them, then let the reviewed plan create exactly
one ingestion consumer per queue. Resolve every supported import ID from the
live Cloudflare account and provider-v5 import contract; never guess an ID or
allow a failed import to turn into a create. Import one address at a time and
inspect it with `tofu state show ADDRESS` before continuing.

Create a dated directory outside the repository and save `tofu state pull`
there before imports, after all imports, and after every apply. The import
baseline plan must contain no creates, deletes, replacements, secret removals,
identity-setting changes, or GitHub concurrency increase. Supply the live
identity values on every plan and apply:

```bash
export TF_VAR_identity_unconfirmed_publication_enabled='true'
export TF_VAR_identity_confirmed_coverage_floor='1'
```

Build the Worker before the final plan. Save that plan outside the repository,
review its complete machine-readable and human-readable output, and apply the
exact saved plan rather than planning again. A final pre-#120 plan may contain
only the reviewed destination queue/DLQ, seven-day retention, 5-message and
60-second consumer settings, Browser binding, queue ID, admission-alert
bindings, and the intentional Worker artifact.

## Gmail application detection rollout

Gmail detection is optional, account-gated, Apply-triggered, and disabled by default. It requests
only `https://www.googleapis.com/auth/gmail.readonly`. A signed-in Apply click records a
short-lived check for that exact catalog role and publishes delayed queue work for
5 minutes, 10 minutes, 30 minutes, and 24 hours after the click. The periodic cron
is a fallback for due checks; there is no continuous full-catalog inbox polling. During an active
check, the Worker retrieves Inbox messages received after the Apply click and extracts at most
16,384 characters of plain text (or stripped HTML/snippet fallback) for deterministic employer,
role, and confirmation matching. Message text is transient and is never stored or logged;
attachments are ignored. The OAuth project must
remain in testing mode with explicit test users until Google restricted-scope
verification and the required annual third-party security assessment are
complete. Existing metadata-scope grants must disconnect and reconnect so Google can obtain
explicit consent for the read-only scope.

In Google Cloud, configure a Web application OAuth client with the exact callback
`https://API_HOST/oauth/gmail/callback`, add only approved test users, and keep
the consent-screen policy/support URLs aligned with this repository. Configure
public identifiers through OpenTofu variables:

```bash
export TF_VAR_gmail_client_id='approved OAuth web client ID'
export TF_VAR_gmail_redirect_uri='https://API_HOST/oauth/gmail/callback'
export TF_VAR_gmail_enabled='true'
```

Set secrets interactively; never put their values in Git, Terraform variables,
shell arguments, mobile configuration, or `EXPO_PUBLIC_*` values:

```bash
npx wrangler secret put GMAIL_CLIENT_SECRET --config wrangler.api.jsonc
npx wrangler secret put GMAIL_TOKEN_ENCRYPTION_KEY --config wrangler.api.jsonc
npx wrangler secret put GMAIL_MESSAGE_HMAC_KEY --config wrangler.api.jsonc
npx wrangler secret put GMAIL_CLIENT_SECRET --config wrangler.ingestion.jsonc
npx wrangler secret put GMAIL_TOKEN_ENCRYPTION_KEY --config wrangler.ingestion.jsonc
npx wrangler secret put GMAIL_MESSAGE_HMAC_KEY --config wrangler.ingestion.jsonc
```

The encryption key and message-HMAC key must be independently generated and
managed. Apply migrations `0006_gmail_detection.sql` and `0007_gmail_application_checks.sql`, provision the dedicated
`intern-notifs-gmail` queue and DLQ through OpenTofu, deploy the Worker, and then
exercise connect/cancel/replay, all four Apply-triggered delays, history continuation, expired
history recovery, exact-role matching, ambiguous review, disconnect, revocation failure, and account
deletion using test users. Inspect structured logs only for operation/error codes;
sender, subject, Gmail IDs, OAuth tokens, message text, attachments, and raw headers
must never appear in logs.

For general availability, keep `GMAIL_ENABLED=false` until the verification and
assessment evidence is recorded, store disclosures are entered, and closed-beta
acceptance passes. Then enable it through a reviewed infrastructure change; do
not turn it on ad hoc in the dashboard.

## Verified employer channel rollout

### Web workspace hosting

The employer workspace is an Expo single-page web application. It is not served by the API Worker and must be exported and deployed to a static host with an SPA fallback:

```bash
npm run build:web
npm run serve:web
```

The export includes Cloudflare Pages security headers plus the public policy pages. Do not add a top-level `404.html`: Pages uses its built-in SPA fallback when that file is absent. Before the first production deployment, create the Pages project with `npx wrangler pages project create internnotifs --production-branch main`, then attach a registered custom domain. Deploy with `npm run deploy:web`. Both `/` and a direct request to `/employer/verification` must return the application shell; refreshing any `/employer/*` section must not return a host-level 404.

The `deploy-web` CI job automatically publishes the exact web artifact verified by `verify-mobile` after `verify`, `verify-mobile`, and the path filter pass on a push to `main`. It runs in the `cloudflare-pages-production` GitHub environment and requires the repository variable `CLOUDFLARE_ACCOUNT_ID` plus a `CLOUDFLARE_API_TOKEN` environment secret scoped to Account / Cloudflare Pages / Edit. Pull requests build the same artifact but never receive the production secret or deploy. Keep `npm run deploy:web` as the manual recovery path.

`https://ntern.app` is the canonical public web address and is attached to the `internnotifs` Pages project. The deprecated `internnotifs.app` domain is not a production health target or public application URL. The customer catalog owns `/`, while the employer workspace is isolated to `/employer/*`. The web bundle calls the API Worker at `https://intern-notifs.jdkrasnick.workers.dev`; set `EXPO_PUBLIC_API_URL` explicitly on the build command only when deploying against another approved API origin. Local `.env` files cannot silently replace the production default.

### Trusted-catalog regression probes

`npm run probes:trusted-catalog` performs a read-only recheck of the three documented exact-role regressions. It fetches their official ATS API records and the corresponding public `GET /jobs/{id}` records, then prints field-level discrepancies. It writes no files or data and uses no credentials. Requests are limited to the fixed three probes, run concurrently, and time out after 10 seconds (override with `-- --timeout-ms 10000`, maximum 30 seconds). A 401/403 is reported as `blocked`; other HTTP, transport, timeout, and invalid-JSON failures are `unavailable`, never a closure or a passing check. Use `-- --api-url <approved API origin>` only for a non-production comparison.

Keep `EMPLOYER_PORTAL_ENABLED=false` while deploying the persistence layer. Apply D1 migrations before the Worker so employer routes can never observe a partial schema:

```bash
npm run cloudflare:migrate:remote
npm run build:cloudflare
# Follow docs/api-ingestion-split.md for the serialized two-Worker cutover.
```

The first provider dispatch idempotently seeds the checked-in Greenhouse, Lever, and Ashby records into `reviewed_source_registry`; scheduled dispatch and queue consumers then read reviewed runtime configuration from D1. Before enabling the portal, compare D1 registry counts and exact source IDs with the checked-in manifests, then verify source health, catalog ordering, grouped projections, and notification outbox counts are unchanged.

Next, enable and exercise `GET /operations/employers/queues` behind the existing operations secret. Pilot one employer through domain challenge, human verification, source shadow admission, and manual direct-role approval. Set the non-secret Worker variable to `EMPLOYER_PORTAL_ENABLED=true` only after that review path is staffed. Automatic publishing remains off per organization until a reviewer explicitly enables it after 90 continuously verified days, 10 approved submissions, and a clean 90-day trust history. Roll back the user surface by restoring the flag to `false`; do not roll back the migration or delete audit/provenance records.

Monitor verification failures and expiry, review-queue age, source freshness, duplicate merges, rejection/quarantine rates, reports, and automatic-publishing suspensions. `GET /operations/employers/reviewed-sources/export` provides the redacted reviewed-source evidence export without members, tokens, private notes, or reviewer identities. The daily maintenance run deletes expired challenge secrets, removes invitations after their grace period, closes date-deadline submissions at the end of their IANA-local date, and suspends expired organizations.

## Catalog quality D1 repair

Deploy the Worker code before inspecting or repairing legacy catalog values. The
command defaults to a read-only scan and reports before/after field counts by
provider, changed/closed/unchanged/unrepairable totals, sample job IDs, and a
deterministic token. Save that complete production report for owner approval:

```bash
export CATALOG_API_URL=https://intern-notifs.jdkrasnick.workers.dev
export OPERATIONS_SHARED_SECRET='use-the-deployed-operations-secret'
npm run migrate:catalog-quality
```

Apply only after approval, with both guards copied from the same dry run. The
Worker rescans before writing, conditionally updates exact JSON values, emits no
outbox events, and refuses stale guards. Any concurrent conflict stops the
grouped projection refresh and requires a new dry run:

```bash
npm run migrate:catalog-quality -- --apply \
  --repair-token EXACT_TOKEN \
  --expected-changed EXACT_COUNT
```

A conflict-free apply rebuilds the grouped projection and includes a verification
audit in its response. Run the standalone dry run once more; it must report zero
changed or closed records. Confirm `GET /jobs`, `GET /catalog`, and a sampled
`GET /catalog/groups/{groupId}` return the preserved job IDs, compact `location`
summaries, structured `locations`, bounded compensation, and unchanged
notification flags. Never store the operations secret in shell history, Git, or
documentation.

## Employer metadata enrichment (#134)

Apply `0015_role_metadata_enrichment.sql`, `0016_role_metadata_repair_plans.sql`
and `0017_metadata_acquisition.sql` before deploying the enrichment Worker.
Extraction v8 and later additionally require `0018_metadata_review.sql` and
`0019_metadata_job_review_revision.sql` before deployment.
The migrations are additive: they store compact versioned field evidence,
historical artifact versions, extraction outcomes, conflicts, and guarded repair
staging, acquisition leases and host backoff. Full job descriptions are never
written to these tables. Preserve the active production publication flags:
`IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED=true` and
`IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED=false`. Admission remains the public
catalog gate: an under-review identity never overrides a failed employer or
destination decision.

After deployment, use the existing destination-verification queue to collect
historical exact-posting evidence. Identity-checked public APIs run first;
Browser Rendering covers unsupported or unsuccessful API routes. Collection is
staging-only and does not rewrite public jobs:

```bash
export CATALOG_API_URL=https://intern-notifs.jdkrasnick.workers.dev
export OPERATIONS_SHARED_SECRET='use-the-deployed-operations-secret'
npm run migrate:role-metadata -- collect --limit 100
npm run migrate:role-metadata -- audit
npm run migrate:role-metadata -- dry-run
```

After each queued batch drains, repeat collection with
`--collection-token TOKEN_FROM_FIRST_RESPONSE` and
`--cursor NEXT_CURSOR_FROM_PREVIOUS_RESPONSE` until the audit reports
`collectionCoverage.complete: true`, with both `pendingOrUnobserved` and
`stale` at zero. Queued or in-flight verifications remain pending until their
extraction attempt is recorded. The dry run returns HTTP 409 and apply refuses
to run while collection is incomplete. Cursor exhaustion only means no more
eligible rows in this pass, not that queued work completed. Restart without a
cursor after pending leases (30 minutes) or retry backoffs expire when needed.

Archive the complete collection and dry-run reports. Review fills and
corrections by field/source class, every conflict, unsupported currencies/pay periods, and
blocked/inconclusive/aggregate outcomes. Unknown values must remain unknown.
Apply only after owner approval, copying all three guards from the same dry run:

`deferredProjections` must also be empty. These jobs retain accepted metadata
whose contributing source evidence predates the current parser. Source
checkpoints require a full successful refresh after extraction/preprocessing
upgrades, without treating HTTP 304s or admission migration slices as completion.
Do not clear evidence or bypass the deferral guard to make the audit pass.

Existing GitHub sources refresh stale parser/preprocessing versions through the
Worker's 20-row continuation limit. A versioned per-row material ledger resumes
successful work, including explicit negative decisions; occurrence stamps alone
do not certify completion because evidence writes can fail after the job commit.
Missing-occurrence work uses separate bounded progress, and reappearing rows
must reconcile before completion. Partial runs retain the previous successful
source timestamp and fetch count. Verify all seven published GitHub checkpoints
reach the current extraction/processing versions and a new complete success;
destination collection is independent and cannot supply that proof. Do not
clear source checkpoints, replay DLQs or bypass backoffs to force completion.

Each dry run stages at most 250 jobs and 8 MiB of original/proposed UTF-8 JSON
in stable job-ID order and reports
`remainingJobs` separately. Field fill/correction counts describe only that batch;
conflicts, evidence freshness and collection completeness still cover the entire
cohort. After an approved batch applies, run a new dry run and obtain approval of
its new token/counts. Repeat until `remainingJobs` and `expectedJobs` are zero;
never increase the atomic limit or reuse approval across batches.

```bash
npm run migrate:role-metadata -- apply \
  --repair-token EXACT_TOKEN \
  --expected-jobs EXACT_JOB_COUNT \
  --expected-occurrences EXACT_OCCURRENCE_COUNT
```

The transaction compares every original job JSON value, emits no outbox event,
and refuses stale counts or any unreviewed metadata conflict. Migration 0018 adds
an atomic revision guard covering evidence, extraction attempts, conflicts,
reviews and catalog mutations, including changes outside the selected batch.
A conflict-free apply refreshes grouped projections and returns an apply receipt
with `verificationRequired: true`. Full verification runs in a separate request
to stay within the Worker memory and D1 query budgets. Run `audit` and
`dry-run` again; `projectionOnlyOmissions` must be empty.
`supportedRoleSpecificDisclosedMetadataMisses` and `disclosureRecall` remain null
until an independent disclosure benchmark exists; do not interpret them as zero.
Sample `/jobs`, `/catalog`, and
group detail results to confirm unchanged job IDs, occurrences, saves,
applications, receipts, notification flags/tombstones, visibility timestamps,
and lifecycle state. Roll back exposure with a new reviewed repair; retain the
evidence and conflict history.

### Reviewed omission of disputed pay

When exact employer evidence genuinely contradicts itself, an operator can
propose leaving compensation blank while preserving separately verified fields
such as housing. This does not authorize choosing a salary or rewriting evidence:

```bash
npm run migrate:role-metadata -- preview-omission --job-id EXACT_JOB_ID
```

Inspect the returned evidence conflicts and obtain owner approval for its exact
`reviewToken` and `expectedDecisions: 1`. Only then run:

```bash
npm run migrate:role-metadata -- approve-omission \
  --review-token EXACT_REVIEW_TOKEN --expected-decisions 1
```

Approval records an auditable decision but changes **zero public jobs**. Run a
fresh repair dry-run and obtain separate approval of its repair token/counts.
Migration 0019 binds review approval to the exact posting's catalog/evidence
revision, so unrelated collection does not expire the preview. Same-posting
changes still reject approval atomically; the separate repair remains guarded
by the catalog-wide revision. Pre-0019 previews must be regenerated.
`reviewedOmissions` lists the exact decisions used by that plan. Every other
field/job conflict and the full collection-completeness gate remain blocking.
Conflict rows remain in history, not silently marked resolved. The activated
receipt keeps pay blank during ordinary projection only while its versioned
evidence fingerprint matches; changed evidence expires the omission and reopens
review. A concurrent evidence, review or catalog change rejects the whole repair.
Stale previews must be regenerated, not force-applied.

After projection, the daily destination-verification scheduler rechecks up to
100 eligible destinations, including never-inspected roles and old extraction
versions, then the oldest observations beyond the revalidation cutoff. Host
rotation and reservations prevent repeated selection of the same batch. The queued
artifact hash prevents an older extraction from satisfying that revalidation.

## Catalog admission rollout (#120)

Create the `intern-notifs-destination-verification` queue and its
`-dlq`, enable the `DESTINATION_BROWSER` Browser Rendering binding, and set
`RESEND_API_KEY` plus `ADMISSION_SUPPORT_RECIPIENT` as Worker secrets. The
checked-in consumer processes at most 5 URLs per batch with concurrency 1, retries twice before
the DLQ, leases due rechecks every ten minutes, synchronizes the schedule daily,
and samples reviewed host rules weekly.
Apply `0007_catalog_admission.sql` through
`0012_destination_verification_schedule.sql` before deploying the Worker because managed
ingestion immediately queries the new review tables. The additive migration is
ordered after the already-deployed
`0011_issue_50_reviewed_employer_identity.sql` migration and is safe for the
currently deployed Worker. Never rename, replay, or replace deployed migration
`0011`; after deployment, legacy rows without
an admission record remain eligible until the guarded repair is approved.

Apply the migration and deploy only after reviewing the generated resource diff:

```bash
npm run build:cloudflare
npm run cloudflare:migrate:remote
# Follow docs/api-ingestion-split.md for the serialized two-Worker cutover.
```

All review and repair endpoints are hidden behind the existing operations
secret under `/internal/admission/`. Begin with read-only `GET` requests to
`audit`, `employers`, `mappings`, `host-rules`, and `incidents`. Use `PUT
/internal/admission/employers`, `POST /internal/admission/mappings`, and `PUT
/internal/admission/host-rules` only for reviewed decisions; replacing a
mapping requires its explicit `supersedesMappingId`. Official single-employer
feeds can use their source ID or tenant as the mapping scope. GitHub community
lists contain many employers and must use the row scope
`employer:<canonical-company-key>` (for example, `employer:acme`); a mapping for
the GitHub source ID is intentionally ignored. Successful polls stamp the
reviewed admission-configuration version into their checkpoint. A later
employer, mapping, or host-rule change clears conditional fetch validators once
and reprocesses the complete source even when its upstream content is unchanged.

Stage legacy changes with `POST /internal/admission/repair` and a `changes`
array. Save the returned `repairToken`, `changed` count, and candidate IDs for
owner review. Apply only the exact approved stage with `apply: true`, that token,
and `expectedChanged`. The D1 transaction refuses changed source JSON or a count
mismatch, writes no notification outbox entries, and refreshes the grouped
projection only after a successful batch. Re-run `GET /internal/admission/audit`
and sample public catalog, Saved, and release APIs afterward. Confirm job IDs,
`firstSeenAt`, catalog recency, source references, posting identities, and
notification markers are unchanged. Do not delete incident, evidence, attempt,
review-decision, or email-delivery history during rollback; roll back exposure
by superseding reviewed rules/mappings and staging a new guarded repair.

Operational alerts should cover destination-verification queue age and depth,
any DLQ message, active/quarantined incident counts by reason, grace deadlines,
and Resend failures. Immediate aggregate/gone quarantines, incident openings,
and grace-deadline warnings are grouped by source, host, and reason and deduped
through the D1 delivery ledger. The Worker also sends daily-deduplicated health
alerts for a non-empty DLQ, a work item older than
`ADMISSION_QUEUE_AGE_ALERT_HOURS`, stale evidence at or above
`ADMISSION_STALE_ALERT_THRESHOLD`, and active admission incidents. These
threshold bindings are managed consistently in Wrangler and OpenTofu.

Open `GET /internal/admission/health` after deployment to verify the live work
queue and DLQ backlog, stale-evidence coverage, active incidents, scheduled
leases, and backfill/repair state in one response. Wrangler and OpenTofu both
manage the destination queue, DLQ, 5-message/60-second consumer, two retries,
and `DESTINATION_BROWSER` binding. OpenTofu retains destination work for seven
days so a one-day delayed transient retry cannot expire before delivery, and supplies
`DESTINATION_VERIFICATION_QUEUE_ID` to the billing-shutdown path. A non-empty
DLQ, an oldest work item approaching the evidence deadline, any unexpectedly
stale eligible record, or an active quarantine is an admission incident.
The audit computes catalog summaries in D1 and returns detail through bounded
keyset pages so both the detailed audit and summary health calculation stay
within Worker memory. Health deliberately omits the review-record and
unresolved-employer detail queries; use the audit endpoint when those operator
details are required.

Admission audit samples default to 100 records and accept `limit` up to 250.
Continue catalog-review records with `afterJobId=<recordsNextCursor>` and
unresolved-employer occurrences with
`afterUnresolvedEmployer=<unresolvedEmployersNextCursor>`. The
`unresolvedEmployers` groups summarize the current occurrence page;
`unresolvedEmployerOccurrences` remains the exact total across all pages.

Destination evidence expires after seven days and is scheduled for recheck one
day before expiry. A transient failed recheck pauses alerts immediately; catalog
visibility lasts only until seven days after the last successful verification.
Retries never restart this window. HTTP 404/410, explicit posting closure language, past structured
`JobPosting.validThrough`, and reviewed aggregate-board decisions bypass grace.
Authoritative closure clears URL validation and closes only the canonical role;
source occurrences and user history remain intact for a later verified reopen.

Historical backfill is resumable and candidate-only:

1. `POST /internal/admission/backfill` with `{"action":"preview"}` freezes an
   exact generation and count.
2. Repeatedly call the same endpoint with `action: "enqueue"`, the generation
   ID, cursor, and a page size no larger than 500. Check progress with
   `GET /internal/admission/backfill?generationId=...`.
   If a bounded page reaches the DLQ, repeat that exact cursor with
   `retryQueued: true`; message idempotency prevents a completed candidate from
   being evaluated twice.
3. Review completed candidate evidence, then call `action: "stage"` with the
   generation ID, one `sourceId`, cursor, and a record limit no larger than 120.
   Save the returned repair token and exact job/occurrence counts.
4. Apply through `/internal/admission/repair` only after owner approval. The
   transaction rejects concurrent JSON changes and verifies every written job
   and occurrence at zero mismatches before refreshing projections. Re-run the
   source-scoped stage; it must report zero changes.

### Guarded production execution

Merging the code does not complete issue #120. Before any migration, import,
plan, apply, backfill, or repair, complete issue #151's due post-#143
observation and record the passing identity gate, active publication flag,
exact coverage floor, alias behavior, queue/DLQ health, and unchanged outbox
baseline.

1. Export production D1 to an absolute path outside the repository. Record
   counts for jobs, source occurrences, Saved/applications, receipts, releases,
   notifications, and pending outbox rows.
2. Apply only `0012_destination_verification_schedule.sql`. Build the Worker,
   review the saved OpenTofu plan described above, apply that exact plan, and
   verify the intentional Worker version reaches 100%.
3. Before backfill, require `/internal/admission/health`, the admission audit,
   and the posting-identity gate to pass. Record work queue/DLQ depth and age,
   leases, freshness coverage, incidents, and operation state.
4. Freeze one historical generation. Enqueue pages of at most 500 until it is
   complete; retry only an exact failed cursor and require an empty DLQ.
5. Review candidate evidence by source, host, employer, classification, and
   notification history. Stage source-scoped batches of at most 120 records.
   Pause for owner approval of every exact repair token and job/occurrence count.
6. Apply only approved batches. Require zero verification mismatches, no new
   notification or outbox rows, and a zero-change restage after every source.
7. Finish with zero legacy-unclassified occurrences and no unresolved employer,
   metadata, destination, projection, or schedule drift. Sample public
   catalog/group/detail, Saved, release, aliases, and official handoff while
   confirming durable IDs, timestamps, source references, posting identities,
   receipts, and notification state remain preserved.

On failure, keep the additive schema and evidence history. Revert the Worker
and configuration through OpenTofu, then use superseding review decisions and
a new guarded repair. Do not delete operational records or revive retired infrastructure
stacks.

### Issue #231 production foundation (2026-09-14)

Export the D1 snapshot outside Git before making catalog-admission changes. The
baseline contained 9,614 catalog internships, 12,183 source occurrences, 326
source-health records, 385 notification events, 29 applications, and 128 push
receipts. Migration `0027_provider_shadow_outbox_index.sql` then applied as the
sole pending migration. The saved OpenTofu plan updated only the API and
ingestion Worker scripts (zero creates, destroys, queue, consumer, or schedule
changes); the exact apply completed with two updates, and a refreshed plan had
no drift. Public `/jobs` returned HTTP 200, with all seven ingestion consumers
and the single ingestion cron still present. This evidence does not authorize a
DLQ disposition, employer mapping, repair, or source resume; those remain
owner-approved operations, and Haize Labs stays paused.

Keep issue #120 and its production roadmap items open after merge and rollout.
The final gate requires physical iOS, physical Android, and production web
acceptance for browse, detail, Saved/unavailable behavior, grouped results, and
official handoff at accessibility text sizes and both device appearance
settings. It also requires a real eligible custom-route role to cross freshness
expiry: a failed recheck pauses alerts, catalog visibility remains only through
the seventh day since the last successful verification, and unresolved
verification removes the role at that deadline. Do not fabricate a production role or waive this observation. Close
#120 only after that transition, three-client acceptance, an empty DLQ,
acceptable queue age, verified alert delivery, passing identity enforcement,
and no unexpected stale-eligible or quarantined incidents are recorded.

### Trusted community source rollout

`simplify-summer-2026` is the only trusted-community source. The source ID stays
unchanged so checkpoints, occurrences, job IDs, saves, discovery times, and
delivery history continue in place. Checked-in runtime defaults keep
`TRUSTED_COMMUNITY_CATALOG_ENABLED=false`; do not add an alert environment flag.
Alert behavior lives in the versioned policy in `src/sources/trust-policy.ts`.

The sanitized baseline report is
[`trusted-community/simplify-summer-2026-baseline.json`](trusted-community/simplify-summer-2026-baseline.json).
Regenerate it from a complete current source fetch before activation:

```bash
npm run source:trusted-community:dry-run -- --record
git diff -- docs/trusted-community/simplify-summer-2026-baseline.json
```

The 2026-09-04 run observed 2,079 raw rows, 1,737 technically eligible rows,
1,091 exact route shapes, 646 browser-inspection candidates, zero surviving
aggregators, and zero duplicate occurrence IDs. Review every candidate route
family and every failure class; require zero identity conflicts, duplicate
alerts, and outbox writes. The dry run calculates the numeric circuit thresholds
from those counts—operators must not hand-edit them.

Roll out in this order:

1. Deploy the Worker, queues, and infrastructure with
   `trusted_community_catalog_enabled=false`. Confirm Simplify policy reports
   `alertMode: disabled` and the existing catalog/outbox counts do not change.
2. Run the current dry run, drain destination-verification work, and inspect all
   646 browser candidates plus aggregate, gone, blocked/unresolved, malformed,
   mismatch, and conflict results. Require zero surviving aggregators and
   duplicate occurrence IDs.
3. Obtain owner approval for the recorded report and reviewed infrastructure
   plan. Set `trusted_community_catalog_enabled=true`; leave the source alert
   mode disabled. The admission-version change performs bounded re-evaluation,
   holds publication until a complete healthy evaluation, marks the admitted
   backlog `baseline`, and permanently suppresses its alerts.
   Evidence collection and subsequent publication both run in bounded slices.
   Publication reuses current-policy evidence for unchanged source facts; the
   policy checkpoint advances only after the remaining publication slices drain.
   Re-admission preserves a role's existing first-visibility timestamp.
4. Verify one complete healthy snapshot and inspect the count-only
   `trusted_community_source_evaluated` metrics. A breach must leave the trusted
   checkpoint unchanged and recover after one complete healthy snapshot.
5. In a separate reviewed configuration change, set Simplify's alert mode to
   `exact-identity-or-two-complete-snapshots` and bump its policy version. Do not
   change the catalog gate for this step.
6. After activation, require stable job IDs, `firstSeenAt`, saves, and delivery
   history; one-time `catalogVisibleAt`; baseline ranking for the activation set;
   no identity conflicts or fuzzy merges; correct pending indexes; and exactly
   one deterministic `new-job` outbox event for each newly qualified role.

Roll back exposure by setting `trusted_community_catalog_enabled=false`. Roll
back alert eligibility by restoring a reviewed disabled source-policy version.
Catalog rollback first drains durable trusted admissions in bounded slices,
including absent and closed occurrences, without depending on an upstream
fetch. Wait for continuation work to finish before declaring rollback complete.
Independently eligible official references remain published. An interrupted
rollback retains its pending checkpoint so either rollback or reactivation can
resume safely; source and delivery history remain intact.
Never delete qualification evidence, source occurrences, identity decisions,
notification tombstones, outbox rows, saves, or delivery history.

Greenhouse, Lever, and Ashby use provider-specific Cloudflare Queues and
staggered Cron triggers in the ingestion Worker. Published boards are checked
every thirty minutes whether active or quiet; shadow boards are staggered
across three-hour checks. See
[`greenhouse/architecture.md`](greenhouse/architecture.md) for the complete
shadow, promotion, retry, and alarm flow.

The seven GitHub community feeds run through their own Queue on the ingestion
Worker. Shadow checkpoints remain isolated and cannot publish jobs or
notifications.

The direct-provider discovery-latency objective is a normal maximum of thirty
minutes from an upstream publication to its next published-board poll. The
GitHub-feed objective is ten minutes, and shadow discovery is intentionally
bounded at three hours. Queue delay, retries, provider backoff, and upstream
timestamp semantics are measured separately from these scheduler objectives.

## DLQ inspection and disposition

Apply additive migration `0015_dlq_recovery.sql` before deploying the Worker.
The protected `POST /internal/operations/dlq` endpoint uses the existing Worker-held
Cloudflare credential to resolve exact allowlisted queue names; never expose that
credential to an operator client. Configure the CLI locally and inspect without
consuming messages:

```bash
export OPERATIONS_API_URL=https://intern-notifs.jdkrasnick.workers.dev
export OPERATIONS_API_KEY='use-the-deployed-operations-secret'
npm run dlq -- inspect lever 25
```

Stage a selective replay or irreversible discard with `DLQ_ACTION=replay` or
`DLQ_ACTION=discard`, a comma-separated list of message IDs, and a reason. Apply
the returned one-use plan within 15 minutes by passing its plan ID, repair token,
and exact expected count. Catalog replay produces one fresh message per source;
destination-verification replay stays disabled until issue #120 lands.

```bash
DLQ_ACTION=replay npm run dlq -- plan lever message-id-1,message-id-2 'Upstream fix verified'
npm run dlq -- apply PLAN_ID REPAIR_TOKEN 2
```

After deployment, compare all six DLQ depths before and after `inspect` to confirm
it is non-consuming. Recover quarantined catalog sources through source controls,
verify healthy-but-paused state, resume them explicitly, and only then discard
superseded DLQ messages. Retain disposition and queue-failure metadata for 30 days.

## Safe operational identifiers

- GitHub: `JDKrasnick/intern-notifs`
- Expo owner/project: `@jdkrasnicks-team/internnotifs`
- EAS project ID: `b9b09ef1-a482-4875-a5f4-ff963488cd3e`
- iOS bundle ID: `com.internnotifs.app`
- App Store Connect app ID: `6792557963`
- Production API: `https://intern-notifs.jdkrasnick.workers.dev`
- Isolated development API: `https://intern-notifs-dev.jdkrasnick.workers.dev`

These are not credentials. Do not record Apple private keys, API keys, Expo tokens, password values, or personal Apple Account emails here.

## Mobile native project ownership

The iOS project is intentionally checked in and manually managed because it
contains `mobile/ios/InternNotifs/TextInputRecyclingFix.mm`. EAS therefore uses
the committed Xcode project and does not regenerate it from `mobile/app.json`.
Keep the app config and native project synchronized when changing the bundle
identifier, URL scheme, version/build number, device family, orientation,
appearance, icons, splash screen, entitlements, or Expo config plugins. Run
`npx pod-install` after native dependency or plugin changes and verify with a
local iOS build. Expo Doctor's generic `appConfigFieldsNotSyncedCheck` is
disabled for this documented manually managed workflow; its package-version
and all other checks remain enabled.

### Posting identity D1 repair

Deploy migrations `0010_posting_identity.sql`,
`0011_issue_50_reviewed_employer_identity.sql`, and
`0012_official_career_provider_identity.sql` and the runtime identity support first,
with `IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED=false`. Greenhouse, Lever,
and Ashby workers then retain contract-versioned immutable posting evidence;
reviewed Workday, ByteDance, Tesla, Meta, Jane Street, Goldman Sachs, and IMC
routes, authoritative employer requisitions, and checked-in canonical-URL
approvals use the same provider-neutral registry.
Unrecognized URL families remain source-local and enter the sanitized review
queue; they do not mint cross-source aliases. Legacy IDs can resolve through
permanent one-hop aliases only after guarded consolidation. The operational
repair runs only against active D1.

The default command calls the protected Worker endpoint in read-only mode. It
builds identity from reviewed source occurrences, provider IDs, and active
checkpoints rather than trusting a stored application URL by itself:

```bash
export CATALOG_API_URL=https://intern-notifs.jdkrasnick.workers.dev
export OPERATIONS_SHARED_SECRET='use-the-deployed-operations-secret'
npm run migrate:posting-identity -- --scope identity
```

Save the complete report. It exposes disagreements in employer identity/name,
title, location, destination URL, and the future #120 admission state/reasons.
Provider identity does not choose any of those fields. Do not apply while
`presentationDisagreements` is non-empty; the endpoint also refuses that apply.
Keep the production dry run for the combined #50/#120 review.

When an employer-owned posting page is the only authoritative presentation
source, record its exact provider tenant, posting ID, company, title, location,
and application URL in `posting_identity_presentation_reviews`. The ledger is
append-only, validates its evidence hash and both official URLs at runtime, and
can resolve only the matching exact identity. A route-level provider match alone
never authorizes a title, location, employer name, or destination choice.

Run the deterministic integrity audit against the same snapshot before any
apply and archive its legacy/classified counts. Exit status `2` is expected
while legacy occurrences still require backfill; it also reports any exact
duplicate, duplicate alert, alias conflict, untracked quarantine, presentation
blocker, occurrence-coverage regression, or job/occurrence identity-projection
mismatch that must be resolved before activation. The gate also requires zero
`duplicateOccurrenceReferences`, keyed by the durable `(sourceId, externalId)`
identity rather than an upstream document row, and zero
`danglingOccurrenceReferences` to deleted jobs even when a permanent alias can
resolve them. `unknownUrlFamilyCandidates` is computed from the dry run's
planned classifications, so repeated unknown or custom URL families are
available for review before any write:

```bash
npm run audit:posting-identity
```

Archive the versioned report, its snapshot digest, repair token, exact write
count, and gate result. A skipped or unavailable live identity contract is
missing evidence, not a passing verification.

Only a dry run with zero conflicts and zero unresolved presentation groups may
be applied, using all three exact guards copied from that report:

```bash
npm run migrate:posting-identity -- --scope identity --apply \
  --repair-token EXACT_TOKEN \
  --expected-changes EXACT_COUNT \
  --expected-duplicate-jobs EXACT_COUNT
```

After the identity phase verifies at zero changes, repeat the same preview and
guarded apply with `--scope occurrences`. This second phase owns only durable
source-occurrence decisions and their synchronized job references; identity
aliases, duplicate consolidation, and user-record remaps remain in the first
phase. It never promotes an ordinary normalized URL to identity evidence and
contains no employer-specific repair exception. It does not insert, reset, or
replay notification/outbox work. Both phases stage exact before-images and use
guarded set-based writes, keeping a production-sized invocation below D1's
query limit. Finally run the default `all` dry run and require zero changes,
zero legacy occurrences, zero `projectionMismatches`, zero
`duplicateOccurrenceReferences`, zero `danglingOccurrenceReferences`, and a
passing gate. A durable occurrence must reference its current internship row
directly; a legacy job-ID alias does not satisfy this invariant.

The dedicated `17 9 * * *` Cloudflare cron runs the same all-scope audit once
per day and emits one aggregate `posting_identity_integrity_audit` event. The
event contains only coverage, duplicate, conflict, quarantine, presentation,
legacy-occurrence, projection, duplicate-reference, and recurring-unconfirmed-
source counts. Any failed integrity gate, coverage regression, audit error, or
three-or-more unresolved occurrences from one source sends one deduplicated
operator email per signal set per day when the private `RESEND_API_KEY`,
`AUTH_FROM_EMAIL`, and `ADMISSION_SUPPORT_RECIPIENT` deployment inputs are set.
The alert never contains role URLs, role titles, or source IDs. Its
`IDENTITY_CONFIRMED_COVERAGE_FLOOR` is an owner-reviewed decimal from zero to
one; a missing/invalid floor, unavailable coverage, or coverage below that
floor is not passing evidence. The checked-in floor is `0`; the persisted
ratchet still fails a drop greater than its one-percentage-point churn buffer.
Treat a production override as a policy threshold with explicit headroom, not
the exact coverage from one audit. Normal growth from reviewed community
sources changes the confirmed/unconfirmed source mix without indicating
identity corruption. Record both the activation snapshot and the lower policy
floor, and review the floor separately whenever the expected source mix
changes. While `IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED=false`, a failed gate
is logged but
 does not fail the invocation. Once publication enforcement is active, a failed
 or unavailable audit fails the invocation. Broader dashboards and source
 discovery-latency metrics remain part of issue #40.

#### Bounded production identity audit (2026-09-15)

The all-scope plan needs the whole catalog in one pass, which does not fit a
Worker invocation at production size. Measured against the 2026-09-14
production snapshot — 9,614 internships, 12,183 source occurrences, and 209.6 MB
of identity row values — the single-pass plan peaked at 787 MB resident memory,
and a compacted projection still needed roughly 450 MB of JavaScript heap. The
daily cron therefore runs `runPostingIdentityAudit`, which reads the same
identity facts through bounded keyset pages and merges them instead of
deserialising the whole catalog.

- Every catalog read is a keyset page (`(pk, sk) > (?, ?)`, 500 rows) plus one
  keyset walk per small kind; no query returns a production-sized result set.
- Each page carries the slice's jobs, the slice's occurrence rows, global job
  heads, and the global review context. Alias claims and notification history
  are resolved only in the final group pass, where whole group membership
  exists; a slice that saw one member at a time would report false claim
  conflicts.
- The audit reads a projection that drops or digests only fields the plan never
  reads by name: `roleMetadata`, `internshipIdentity` beyond the reviewed
  company ID, occurrence metadata evidence beyond its slot and digest,
  `sourceMetadataProcessing`, and reference-level admission. Everything the gate
  reports is kept verbatim, and `test/posting-identity-audit.test.ts` pins the
  equality against a single-pass plan over the same catalog.
- `POST /internal/posting-identity-repair` accepts `{"audit": true}` with an
  optional `jobBatch`. `npm run audit:posting-identity` uses that mode, so the
  gate no longer depends on a single unbounded read.
- Before a manual posting-identity or catalog-quality scan, use authenticated
  `GET /internal/operations/bulk-window`. It returns `200 {"ready":true}` only
  when every work queue reports zero backlog and the last 30 minutes contain no
  recorded D1 overload. A missing queue metric or D1 check returns retryable
  `503`; the two bulk endpoints repeat this check immediately before scanning.

Measured on the production snapshot on 2026-09-15: the paged audit returned
exactly the single-pass gate, coverage, duplicate, presentation, conflict, and
outbox facts in 20 pages at the default batch, used 14 s of CPU, and completed
under a 104 MB V8 heap cap (96 MB at a 250-job batch). The single-pass plan
needs 787 MB resident and over 256 MB of heap before it fails. That envelope
still has to be confirmed in the deployed Worker before the daily gate is
trusted. The guarded repair plan and apply are unchanged and still read the
whole catalog: plan or apply a repair from a bounded scope, or outside the
Worker, until a batch-scoped repair read is reviewed.

#### Issue #50 staged production execution

Keep the checked-in Terraform and Wrangler defaults at `false` throughout this
procedure. Store exports, full audit reports, manifests, and secrets outside
Git. Do not close issue #50 or its product-roadmap checkbox until the final
12-hour acceptance window passes.

1. Export production D1 to an absolute path outside the repository with
   `npx wrangler d1 export intern-notifs-db --remote --output ABSOLUTE_PATH`.
   Record baseline counts for internships, durable source occurrences, saved
   applications, delivery receipts, catalog releases, notification
   tombstones/events, and pending outbox rows.
2. Run `npm run cloudflare:migrate:remote`, confirm both `0010` and `0011` in
   the applied migration list, then deploy the Worker with
   `IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED=false`. Do not apply either repair
   phase yet.
3. Let the admission-configuration version change force complete Greenhouse
   and GitHub source reprocessing. Wait for both work queues and DLQs to drain,
   then verify every affected checkpoint records the new configuration version.
4. Run `npm run audit:posting-identity` read-only. Archive its snapshot digest,
   repair token, exact counts, blockers, and unknown-URL-family report outside
   Git. A skipped audit or missing live evidence is a failure.
5. Require all four former presentation blockers across Aquatic Capital
   Management, Jump Trading, and Squarepoint Capital to be resolved. Obtain
   owner approval for the exact identity-scope manifest,
   including token, expected changes, and expected duplicate jobs.
6. Apply the identity scope with the approved token and counts. Immediately
   preview it again and require `expectedChanges: 0`, `duplicateJobs: 0`, and no
   conflicts or presentation disagreements.
7. Preview the occurrence scope, obtain its independent token/count guards,
   apply it, then run the final all-scope audit. Require a passing gate and every
   mutation count at zero. Record its exact `confirmedCoverage` as the
   activation baseline, then propose a lower owner-reviewed production floor
   with enough headroom for expected source-mix changes.
8. Confirm notification-event, notification-tombstone, pending-notification,
   and outbox counts match the baseline. Test all eight affected legacy job IDs
   and their canonical aliases, representative catalog/group endpoints, saved
   applications, releases, and official application links.
9. Run the Greenhouse, Lever, and Ashby live contracts without skipped
   evidence. Axon, Databricks, and Momentus must either produce current evidence
   or remain quarantined while publication stays disabled.
10. Deploy the compatible web client and prepare the mobile build. The owner
    performs physical-device QA for card/detail/Saved labels, grouped counts,
    individual and grouped push copy, large text, and the intentional light
    appearance under both light and dark device settings.
11. After owner approval, first review and apply a production OpenTofu plan
    setting `identity_confirmed_coverage_floor` to the approved value while
    publication remains disabled. Trigger the daily audit and require it to
    pass. Then review and apply a separate plan setting
    `identity_unconfirmed_publication_enabled=true`. Keep the checked-in
    publication default `false` and coverage floor `1` as fail-safes.
12. Observe at least one complete 12-hour source cycle and one successful daily
    posting-identity audit. On any regression, disable the flag first and do not
    attempt another repair until a fresh guarded preview passes.
13. Only after those checks pass, update issue #50 and
    `docs/product-roadmap.md` as complete with sanitized rollout counts and links
    to the production checks.

Production record (2026-09-01): PR #143 merged as `1117624` and deployed at
100% as Worker version `68e4e374-693c-4ab6-a9b1-e302953c91df`. The final audit
classified 4,339 confirmed and 1,746 unconfirmed occurrences, for exact coverage
`0.7130649137222679`, with zero duplicate, conflict, quarantine, presentation,
legacy-occurrence, projection, duplicate-reference, or dangling-reference gate
violations. All 12 affected official destinations returned HTTP 200, legacy and
canonical role behavior matched, and the outbox remained at 384 rows. Production
set the coverage floor to that exact value before enabling unconfirmed
publication. The owner explicitly waived step 12 as an acceptance gate; the
post-activation scheduled audit passed with enforcement active, and non-gating
follow-up issue #151 was initially scheduled for `2026-09-02T04:18:01Z` before
the owner requested the analysis early.

Early follow-up (2026-09-01): normal reviewed-community ingestion moved exact
coverage below the snapshot-pinned floor even though every structural blocker
remained zero. Publication was disabled first. PR #153 made immutable decisions,
durable attachment facts, and presentation ownership converge, then a guarded
repair applied one identity normalization and 360 occurrence normalizations.
The final audit reported 4,480 confirmed and 1,873 unconfirmed occurrences,
coverage `0.7051786557531875`, zero planned changes, and every structural blocker
at zero. Worker version `588233d1-5230-4af7-b8f3-70d725ba9392` runs at 100% with
publication enabled and a buffered `0.70` policy floor; the enforced scheduled
audit passed. Checked-in Wrangler and Terraform defaults remain `false` and `1`.

For eligible groups whose presentation already agrees, the repair preserves the
oldest catalog job, merges source references,
visibility/observation dates, open and notification state, remaps source
occurrences, applications, sessions, receipts, catalog releases, and employer
field proposals, and retains the furthest application status plus all distinct
notes. Exact before-images are staged; a transaction guard refuses concurrent
changes. No notification/outbox row is inserted or rewritten. A successful
apply rebuilds the grouped catalog projection and returns a verification dry
run.

The guarded preview reads active reviewed employer mappings directly. This lets
historical community spellings resolve to the same canonical employer as the
official connector even when the legacy job predates per-occurrence admission
stamps. Those mappings are included in the snapshot digest; conflicting active
mappings remain a hard blocker. Consolidation also derives the retained job's
canonical admission from its merged occurrence evidence before legacy job-ID
aliases become visible.

After #120 provides a reviewed employer/metadata/destination/admission decision,
run the combined reviewed repair and quarantine any group it leaves unresolved.
Run the standalone dry run again and require `eligibleDuplicateJobs: 0`,
`expectedChanges: 0`, and no conflicts. Unresolved identity matches remain in
`duplicateJobs` until #120 resolves them; they must not be silently
consolidated. Record notification/outbox counts before and after and require
them to be unchanged. Verify both canonical and sampled
legacy job IDs through `GET /jobs/{jobId}`, representative Greenhouse standard,
`gh_jid`, DRW/Roblox custom-host, and Lever hosted/`apply` URLs, saved
applications, releases, `GET /catalog?limit=1`, `GET /catalog/days?from=<first
of the current month>&to=<today>` (it must return the release days the calendar
fills, with `zone: "UTC"` unless a zone was requested), and one returned
`/catalog/groups/{groupId}`. Never put the operations secret in Git,
documentation, or shell history.

Ship and verify the compatible mobile/web client before changing
`IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED` to `true`. In the disabled state,
new identity-unconfirmed observations are retained for review but excluded from
catalog and alert publication. Before activation, verify light/dark mode, large
text, card/detail/Saved labels, grouped unconfirmed counts, and individual and
grouped push copy on iOS and Android. The owner performs physical-device QA and
approves both the guarded production manifest and the flag change.

After the Cloudflare deployment, wait for the next ingestion Cron cycle and
maintenance pass. Verify `GET /catalog?limit=1`, one returned
`/catalog/groups/{groupId}`, and the resulting release and receipt records
before enabling publication. Cloudflare does not use the retired SSM cohort or
provider-specific stack activation procedure.

## Provider monitoring verification

Greenhouse, Lever, Ashby, and GitHub ingestion share the
`intern-notifs-ingestion` Worker, D1, and provider-specific Cloudflare Queues.
Deploy them together through the reviewed OpenTofu plan described above. After
deployment, verify `GET /operations/sources` reports every provider, exercise
pause, recover, resume, and replay on one shadow source, and compare every queue
and DLQ depth before and after the test. Provider admission manifests remain
required; deployment success alone never promotes a source.

## EAS environments

The production EAS environment must have these six public variables:

- `EXPO_PUBLIC_API_URL`
- `EXPO_PUBLIC_PRIVACY_URL`
- `EXPO_PUBLIC_TERMS_URL`
- `EXPO_PUBLIC_RETENTION_URL`
- `EXPO_PUBLIC_SOURCE_POLICY_URL`
- `EXPO_PUBLIC_SUPPORT_URL`

Check them without printing their values:

```bash
cd mobile
npx eas-cli@latest env:exec production 'npm run release:check'
```

`mobile/eas.json` uses remote iOS build numbers and the `sdk-55` build image. Do not remove that image: Apple requires the iOS 26 SDK/Xcode 26 generation for uploads.

## Build and TestFlight release

Run from `mobile/` after the target commit is committed and CI is green:

```bash
npx eas-cli@latest env:exec production 'npm run release:check'
npx eas-cli@latest build --platform ios --profile testflight --auto-submit --non-interactive
```

This auto-increments the iOS build number, builds from the current Git commit, and schedules App Store Connect submission. Wait for EAS to finish, then wait for Apple processing (typically several minutes). The Build ID and source commit are visible on the EAS build page.

For a manual submission of an already finished build:

```bash
npx eas-cli@latest submit --platform ios --profile testflight --id BUILD_ID --non-interactive
```

After Apple processing:

1. In App Store Connect → TestFlight, locate the new build.
2. Add it to the intended **Internal Testing** group if it is not automatically available.
3. The tester must accept their App Store Connect invitation and use TestFlight with that same Apple Account. Internal testers do not use redeem codes.
4. Follow [`testflight-checklist.md`](testflight-checklist.md) on a physical iPhone.

## Current release context (2026-09-08)

- Build `1.0.0 (25)` was built from `a8a00af` (merge of #170: tap-to-apply
  sheet filters, fade modal with dim backdrop, stacked Show roles over Clear).
  EAS build `2968602c-abc6-4029-97bb-9c160f1c7ba2`, auto-submitted to App Store
  Connect (submission `efef6340-0fb1-41b9-b432-f4c85d54878b`). No Worker change:
  production Worker `8ce99030` already serves the merged server code.
- Build `1.0.0 (24)` was built from `beeae3c` (merge of #168: Filter roles
  bottom sheet with working Role focus/season/work-mode/education/pay filters,
  white Save pill with tap-to-unsave, inline pay, collapsed identity row).
  EAS build `1006ec45-ad48-4d34-afa9-1d396ee474bc`, auto-submitted to App Store
  Connect (submission `5ff86328-e5ed-4501-9dec-fe60c1f72733`).
- Production Worker version `8ce99030-a2b2-43e9-874d-f3cd4f203eb7` was deployed
  from `beeae3c` on 2026-09-07 (D1 already at migration `0015_dlq_recovery.sql`,
  nothing to apply). This was required: the previous Worker predated #168 and
  silently ignored `hasCompensation` and discipline aliases.
- Simulator parity verified against production on 2026-09-07 from the same
  source: Role-focus AI/ML chip filters the feed, pay filter returns paid-only
  roles, cards render `Los Gatos, CA · winter-2027 · $63/hour` inline with no
  tofu glyphs, detail sheet stacks Save for web below Apply with collapsed
  identity. Saved-state unsave toggle still needs a signed-in account check.
- Remaining owner steps: add build 24 to Internal Testing, run
  [`testflight-checklist.md`](testflight-checklist.md) on a physical iPhone
  (push permission, real push delivery, deep links cannot be verified on the
  simulator), then submit for App Review.

## Physical-device checks agents cannot fake

An agent can verify configuration and automated tests, but a real iPhone/TestFlight session is required to verify:

- notification permission approval and denial;
- receipt of a real Expo push and notification deep link behavior;
- installed icon, splash, and build number;
- user-facing policy/support links; and
- full account deletion against the deployed environment.

Once an owner-installed build registers a push token, an agent may use the AWS CLI/Expo operational workflow to trigger a test push, then the device user confirms delivery and tap behavior.
