# Shadow extraction

The shadow extraction queue evaluates exact official posting descriptions.
Extraction remains separate from publication: only a human-evaluated,
exact-revision receipt can project an allowlisted field into catalog metadata.
It never changes admission, destination checks, lifecycle, notifications, or
repair plans.

## Data flow and safety boundary

Normal Greenhouse, Lever, and Ashby polls atomically persist a revision-keyed
handoff with the catalog observation. The evaluation-only handoff accepts an
exact official ATS posting when `employer-unresolved` is its sole admission
blocker; catalog publication and alerts remain admission-gated. Aggregate,
gone, conflicting, unattributed, or metadata-invalid postings remain excluded.
`destination-verification` then validates
the exact posting identity and writes a bounded normalized
description to the private `intern-notifs-shadow-extraction` R2 bucket and
enqueues only a compact reference: posting IDs, source identity, content hash,
versioned cache key, and R2 object key. Queue messages never contain the source
description, prompts, user data, credentials, or an arbitrary URL to fetch.
The acquisition report records the handoff outcome (`enqueued`,
`skipped-no-text`, `skipped-no-binding`, or `failed`), acquisition method, and a
description byte count. Each run records an immutable `provider-poll`,
`scheduled-verification`, `controlled`, `backfill`, or `legacy-unknown` origin.
Missing bindings and downstream write/queue failures
retry the destination message after five minutes; an empty verified artifact is
recorded but does not retry. The aggregate operations response groups these
outcomes without exposing posting text, URLs, or identifiers.

The consumer validates the message and its artifact hash, deduplicates by
content hash plus model/prompt/schema/preprocessing versions, and records run
state in D1. A later artifact revision becomes current before it is queued; a
late result for an old revision is marked `obsolete` and cannot replace it.
Results remain in `shadow_extraction_*` tables, separate from deterministic
role metadata and public catalog tables unless a coordinator creates a receipt
for one exact completed revision and the deployment policy independently names
that same `{sourceId, externalId, contentHash}` cohort entry.

The request contract combines classification and extraction. Factual fields
retain `value` or `null`, `present`/`not-stated`/`conflicting`/`incomplete`,
verbatim supporting passages, and qualifiers. The runtime validator rejects
missing passages, malformed outputs, unsupported currency/period values, and
numeric inconsistencies. Passing JSON or a model confidence value does not make
a result employer-authoritative.

## Cost guard and rollout

Production shadow execution uses the pinned `gpt-4o-mini-2024-07-18` snapshot
through OpenAI Chat Completions schema-backed JSON mode. Store `OPENAI_KEY` as a Worker secret;
never put it in Wrangler variables, Terraform state, queue messages, or artifacts.
`SHADOW_EXTRACTION_ENABLED` controls calls independently from publication.

Enabled execution must provide both
`SHADOW_EXTRACTION_MONTHLY_FORECAST_CENTS` (the forecast for all existing
Cloudflare usage) and `SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS`. The consumer
fails closed unless cumulative reservations and reconciled actual usage fit both
the shadow headroom and the combined $20/month cap. A single request can finish
slightly above its conservative reservation, but that actual usage reduces later
capacity. It retries one transient delivery
with a five-minute delay; malformed output is a visible `invalid-output` state,
not a repair loop.

Use the authenticated, read-only endpoint below for aggregate run states,
latency, cost totals, version distribution, and deterministic-baseline differences:

```text
GET /internal/operations/shadow-extraction
```

`LLM_METADATA_PUBLICATION_POLICY_JSON` is a plain Worker variable, not a
secret. Its committed default is disabled and empty. A valid enabled policy has
`version`, a non-empty supported `allowedFields` set, and unique exact cohort
entries. The authenticated operations endpoint
`/internal/operations/shadow-publication` reports policy state, versioned field
evaluation metrics, extraction scope, and the natural-production rollout gate.
The gate fixes its review cohort to the first 25 completed runs from ordinary
`provider-poll` or `scheduled-verification` traffic on the current pinned model,
prompt, schema, and preprocessing versions. A run counts as reviewed only after
all seven fields have a decision. New publication receipts fail closed until
every cohort run is reviewed and each policy-allowed field has measurable
precision and recall of at least 95%. This also requires at least one
`correct-present` production example, so compensation cannot be enabled from an
absent-only sample. Existing exact-revision receipts remain active and identical
receipt requests stay idempotent while the gate is pending.

`record-evaluation` stores one of
`correct-present`, `correct-absent`, `false-positive`, `false-negative`,
`wrong-value`, or `wrong-status` for each reviewed run field, and returns a
per-field `conformance` advisory against the deterministic baseline recorded on
the run (`shadow_extraction_baseline_differences`): `deterministic-confirm`
when deterministic evidence also says present, `deterministic-conflict` when the
model field status differs from the deterministic baseline,
`deterministic-consistent` when their presence/absence states agree,
`baseline-inconclusive` when deterministic evidence is incomplete or
conflicting,
`baseline-unavailable` when a covered field has no recorded baseline, and
`llm-only` for eligibility, which the deterministic extractor cannot express. A conflict is a review signal, not a
block: `create-receipt` requires `correct-present` for every selected field as
well as a completed, validator-accepted, current posting revision, and a human
`correct-present` review overrides a silent deterministic baseline. Policy
membership alone never authorizes publication.

Receipts bind the run key, posting identity and hash, policy version, accepted
field subset, and deterministic evidence fingerprint in D1. A newer posting
revision invalidates the receipt check. Disabling the policy stops new receipts;
it does not claim to repair any previously published metadata.

## Deployment and retention

Apply migrations `0020_shadow_extraction.sql`,
`0021_shadow_extraction_fencing.sql`, and
`0022_shadow_extraction_cache_expiry.sql`,
`0023_shadow_extraction_attempt_costs.sql`,
`0024_shadow_publication_receipts.sql`,
`0025_shadow_extraction_evaluations.sql`, and
`0026_shadow_extraction_origin.sql` before deploying the queue consumer.
Provision the private R2 bucket and the `shadow-extraction` work/DLQ
queues from the infrastructure configuration. Configure this R2 lifecycle rule
after the bucket exists, using credentials with only the documented R2 write
permission:

```sh
npx wrangler r2 bucket lifecycle add intern-notifs-shadow-extraction shadow-input-30d shadow-input/ \
  --expire-days 30
npx wrangler r2 bucket lifecycle add intern-notifs-shadow-extraction shadow-response-30d shadow-response/ \
  --expire-days 30
npx wrangler r2 bucket lifecycle list intern-notifs-shadow-extraction
```

R2 lifecycle deletion is asynchronous (normally within roughly a day of the
expiry date), so verification must show both prefix rules. Roll back by setting
the enablement variable to `false`; do not remove the migration or delete run
records. The queue consumer then records no model calls and leaves the public
catalog unchanged.

## Publication scope

The initial production canary allows `locations` and `workMode` only on exact
reviewed revisions. Every published field needs a human `correct-present`
evaluation, a validator-accepted quoted passage, a publishable normalized value,
and an active receipt. Direct official evidence outranks reviewed shadow evidence.
Compensation remains shadow-only until evaluated production examples include
actual pay disclosures. Housing, timing, education, eligibility, and classification
are evaluated but have no publication conversion.

The v5 contract accepts only canonical `remote`, `hybrid`, or `onsite` work modes
and forbids `not-stated` for missing fields when input is truncated. Evaluation
metrics expose field precision and recall when their denominators are available;
an empty denominator is reported as `null`, not as a passing score.
