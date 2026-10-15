# Shadow extraction

The shadow extraction queue evaluates exact official posting descriptions.
Extraction remains separate from publication. Exact-cohort publication needs a
human-evaluated exact-revision receipt. Production's prospective provider-poll
mode publishes compensation and locations only after an independent model pass
verifies the same values against a complete, fresh official posting.
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
Preprocessing `exact-posting-markdown-v3` includes exact provider locations,
work mode, compensation text and labeled bands, and application deadlines in
the same bounded evidence corpus as the description. Units and applicability
labels come from the source; publication and update dates are not deadlines.
All API handoff paths preserve these structured fields, including scheduled
verification and historical collection. A changed evidence corpus changes the
content hash; the preprocessing revision also prevents reuse of v2 results.
Prior v2 evaluations do not establish accuracy for this new input format.
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
Results remain in `shadow_extraction_*` tables until publication creates a
receipt for the exact current revision. Exact-cohort mode requires independent
deployment membership for that `{sourceId, externalId, contentHash}`.
Prospective mode instead requires a post-activation provider observation and
verification artifact bound to the active policy version and start time.

The request contract combines classification and extraction. Factual fields
retain `value` or `null`, `present`/`not-stated`/`conflicting`/`incomplete`,
verbatim supporting passages, and qualifiers. The runtime validator rejects
missing passages, malformed outputs, unsupported currency/period values, and
numeric inconsistencies. Passing JSON or a model confidence value does not make
a result employer-authoritative.

## Cost guard and rollout

The next-release extraction candidate is `gpt-6-luna`, at medium effort with
an 8192-token total cap. `claude-haiku-5-5` remains an explicitly selectable
alternative with its own credential. Extraction, bounded repair, and prospective
verification use the selected provider. Model and prompt revisions are included
in cache identities. Revision v52 preserves exact worksite labels, complete linked
qualifications, atomic authorization policies, and role-specific terms while
excluding generic employer policy and recruiting audiences. Neither a program
audience nor a preference implies a minimum degree. Six prompt-only iterations
improved the fixed source score from 328/337 to 336/337, with a separate synthetic
contrast score improving from 106/112 to 109/112. These are development evidence,
not production acceptance; see [the evaluation and remaining gaps](shadow-prompt-v52-evaluation.md).

The shared validator recognizes source-supported country/currency aliases and
localized pay formatting. Haiku reuses one schema definition for list-valued
fields to avoid its real grammar-compilation limit; all providers retain source
quote, status, numeric, and unit validation. Provider descriptions cannot
substitute for the domain validator or source-based accuracy evaluation.

Local evaluations select credentials by model: `OPENAI_API_KEY` or `OPENAI_KEY`
for Luna, `ANTHROPIC_API_KEY` for Haiku. Paste the latter in the gitignored root
`.env`. The three evaluation runners support explicit `--model` comparisons.
Missing selected-provider credentials fail closed, with no provider fallback.
Existing OpenAI icon features retain their own adapter and settings.

`npm run test:metadata-model:live` checks the active model's complete production
schema. `npm run test:anthropic:live` checks Haiku explicitly. Both are opt-in;
the normal suite skips live calls and requires no real credential.

Provision `OPENAI_KEY` for the selected Luna model and `ANTHROPIC_API_KEY` for
the Haiku alternative as secrets on ingestion Workers, including dev. Never
put values in Wrangler variables, Terraform state, queue messages, artifacts,
or public/mobile variables. OpenTofu preserves `secret_text` bindings.
`SHADOW_EXTRACTION_ENABLED` controls calls independently from publication.

Both automatic prospective publication and manual receipt creation require
25 fully reviewed natural runs from the exact model/prompt/schema/preprocessing
version, with at least 95% precision and recall and positive examples for every
policy-allowed field. A verified output from another model version cannot gain a
new automatic or manual receipt. New manual receipts also check the candidate's
own version tuple before using the current review gate. An already authorized
exact receipt can finish projecting while the next model's gate is pending;
the maintenance selector prioritizes unprojected active receipts ahead of pending
new candidates. A recovery whose role closes or loses its exact source records a
terminal skipped decision so later candidates can proceed. Transient projection
failures remain retryable. Migration 0055 gives the bounded review
query an index ordered by exact version and completion time.

All-field publication contracts/conversions, explicit deadline support, and
scoped historical execution remain separate release work; changing the provider
does not implement them. Source-based holdouts and housing/deadline challenge
cases still apply before those fields are promoted.

Enabled execution must provide both
`SHADOW_EXTRACTION_MONTHLY_FORECAST_CENTS` (the forecast for all existing
Cloudflare usage) and `SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS`. The consumer
fails closed unless cumulative reservations and reconciled actual usage fit the
total model allowance (at most $20/month with the $20 headroom binding), and the
forecast plus model usage stays within $35/month. The legacy smaller binding
retains its earlier limits. Historical/non-provider work also has its own
$10/month sublimit starting in October 2026, with forecast plus historical usage
capped at $25/month; earlier periods retain their original limits. Provider
traffic and fixed diagnostic probes do not consume that sublimit. Every lane
still consumes the total model allowance. Unknown
billed usage remains charged to both applicable limits. Budget status exposes
historical spending and available capacity after both limits, so a partial
backfill must stop when either is exhausted. A single request can finish
slightly above its conservative reservation, but that actual usage reduces later
capacity. It retries one transient delivery
with a five-minute delay; malformed output is a visible `invalid-output` state,
not a repair loop.

When a requested model call fails without trustworthy usage, its reservation
stays held: the provider may still bill a timeout or truncated response. A failed
optional repair or verification records known usage and keeps the remaining
reservation. Operations must reconcile those unknown costs against provider
billing before releasing headroom; they are not reported as measured token cost.

Use the authenticated, read-only endpoint below for aggregate run states,
latency, cost totals, version distribution, input completeness by origin and
terminal state, validator failures by cause, and deterministic-baseline
differences:

```text
GET /internal/operations/shadow-extraction
```

For a deployed-runtime check, authenticated `POST
/internal/operations/shadow-extraction/probe` queues fixed synthetic data through
the real consumer. `GET` on the same path reports durable usage and checks the
known pay, location, work mode, and absence of extra claims. Repeated requests
reuse an existing result; `POST ?retry=true` can retry a failed probe. No caller
supplies posting text. Probes have origin `controlled`, never count toward the
natural cohort, and cannot create Catalog jobs or publication receipts. Their
$1 monthly diagnostic envelope remains inside the existing total model ceiling;
the historical backfill sublimit is unchanged.

`LLM_METADATA_PUBLICATION_POLICY_JSON` is a plain Worker variable, not a
secret. Production templates default to disabled; the deployment environment
supplies the enabled policy. Dev templates carry their enabled prospective
policy. A valid enabled exact-cohort policy has
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
`0025_shadow_extraction_evaluations.sql`,
`0026_shadow_extraction_origin.sql`, and
`0032_shadow_extraction_input_completeness.sql` before deploying the queue consumer.
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

Production's active policy is `prospective-provider-poll-2026-09-v1`, starting at
`2026-09-24T03:20:27.000Z`, with automatic compensation and location publication.
This policy is separate from V1/V2 admission ownership. It excludes historical
backfill, incomplete inputs, and artifacts that do not carry the active policy's
verification identity. The second pass can veto a candidate field but cannot add
or change its values. A current posting revision and attached open catalog role
are checked before projection. Each publication creates a durable receipt; the
initial 25-receipt cap has been removed, while monthly inference cost remains
bounded. Dev uses the same field scope with an independent activation time and
policy version, shared by its extraction Worker and dedicated publisher.

The following exact-cohort workflow remains available for human-reviewed
revisions and is distinct from prospective automatic publication.

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

The aggregate shadow operations response also reports input completeness by
origin and terminal state, validator failures grouped into model-schema,
model-evidence, model-normalization, and input-incomplete categories, and those
same failures attributed by origin, input completeness, and category. The
attribution join is what separates a bounded source artifact from a malformed or
unsupported model response. The completeness column is forward-only, so a run
that predates it reports `unknown` instead of receiving a retroactive source
diagnosis. `input-incomplete` is the `not-stated is invalid for incomplete
input` failure, which the validator raises only for a bounded artifact, so it
never counts as a model defect. A run that never reached validation — an input
identity or version mismatch — carries `invalid-output` with no validator
failures, so the failure rows can sum to less than the `invalid-output` count,
and unreadable validator JSON is skipped rather than failing the response. None
of it exposes posting text, URLs, or run IDs.
