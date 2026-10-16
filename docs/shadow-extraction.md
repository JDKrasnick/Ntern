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

### Compact role facts

Prompt v55 / schema v6 returns housing, timing, education, and eligibility as
arrays of short, self-contained phrases. Aim for 2–10 words per phrase, bounded
at eight phrases of 160 characters each. Keep a condition in the same phrase
as the claim it limits; preserve negatives, alternatives, and exceptions.
Exact supporting passages remain private and are not shortened for display.
Pay uses the existing structured currency/range/period formatter. Role details
render small wrapping tags grouped under Pay, Location, Work mode, Housing,
Dates, Education, and Eligibility. Tags are informational and never clipped.

The display layer uses brief captions (at most 24 characters each, at most three
per field) with full statements and qualifiers in an inline disclosure. Unknown
wording receives a neutral details caption instead of a guessed or truncated
claim. Pay varies opens at most three distinct scoped pay options; additional
options remain on the official listing. A housing stipend with no stated amount
is explicitly labeled as such. These presentation rules also apply to legacy
pay and housing data, without changing extraction or requiring inference calls.

This profile changes the inference cache key and invalidates earlier publication
approvals. Existing v52 historical runs must be re-extracted and reviewed before
they can be included in a v55 release plan; changing the policy version alone
does not convert their output into compact facts.

Preprocessing `exact-posting-markdown-v3` includes exact provider locations,
work mode, compensation text and labeled bands, and application deadlines in
the same bounded evidence corpus as the description. Units and applicability
labels come from the source; publication and update dates are not deadlines.
All API handoff paths preserve these structured fields, including scheduled
verification and historical collection. A changed evidence corpus changes the
content hash; the preprocessing revision also prevents reuse of v2 results.
Prior v2 evaluations do not establish accuracy for this new input format.
Source processing revision 6 also stores a separate structured-evidence hash.
Existing occurrences establish this baseline without new natural extraction;
later work-mode, location, or compensation changes can trigger extraction even
when prose is unchanged. Legacy polling and the V2 catalog writer use the same
comparison, include both revisions in retry identity, and bind queued work to
the current source metadata revision. Publication/update timestamps are excluded.
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

The selected extraction model is `claude-haiku-5-5`, at medium effort with
an 8192-token output cap and its own Anthropic credential. Extraction, bounded repair, and prospective
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

Local evaluations select credentials by model: `ANTHROPIC_API_KEY` for the
selected Haiku profile, or `OPENAI_API_KEY`/`OPENAI_KEY` for explicitly requested
Luna comparisons. Paste the Anthropic key in the gitignored root
`.env`. The three evaluation runners support explicit `--model` comparisons.
Missing selected-provider credentials fail closed, with no provider fallback.
Existing OpenAI icon features retain their own adapter and settings.

`npm run test:metadata-model:live` checks the active model's complete production
schema. `npm run test:anthropic:live` checks Haiku explicitly. Both are opt-in;
the normal suite skips live calls and requires no real credential.

Provision `ANTHROPIC_API_KEY` for metadata and retain `OPENAI_KEY` for icon
resolution as secrets on ingestion Workers, including dev. Metadata fails closed
when the Anthropic credential is missing and never falls back to OpenAI. Never
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

### Owner-approved full metadata release

The October 15 release supports all seven fields: compensation, locations, work
mode, housing/relocation, dates/commitment, education, and eligibility. The owner
explicitly approved public publication after the prompt evaluation, development
checks, and official-source spot checks, accepting expected extraction error.
`releaseApproval` records that decision against the exact model, prompt, schema,
and preprocessing profile. An invalid or changed profile disables that policy;
approval is never carried automatically to a new extraction profile. The natural
25-run review metrics remain visible and are not represented as passing.

The prospective publisher retains independent verification, exact current posting
revision, open attached catalog role, and validator-accepted present-field checks.
The verifier must retain both values and qualifiers. Negative statements such as
no housing or restricted work eligibility remain negative; missing/conflicting
fields are omitted. Public `postingFacts` retain the field statements, qualifiers,
official source URL, and content hash. They supplement existing typed metadata;
dates and eligibility text do not silently change lifecycle, filters, or alerts.
Text that exceeds the display bound is omitted rather than truncating a condition.
Conflicting statements from attached sources are withheld.

An approved policy may also bind up to 1000 exact historical source/posting/hash
entries through `historicalCohortRoot` and `historicalCohortSize` in the approval.
The compact root fits Cloudflare's variable limit; each request supplies a bounded
Merkle membership proof for its exact revision. Authenticated `publish-approved` publishes only those exact
validated revisions and creates normal receipts. It does not fabricate per-field
human evaluations. The backfill runner freshly reacquires official sources and
rejects changed, closed, detached, or unavailable roles before publication.
`deferProjection: true` allows bounded batches; `refresh-approved` accepts at most
20 existing active receipts, refreshes the catalog once, then marks them projected.
Individual job reads expose the canonical facts; grouped cards and web/native role
details carry the same facts. No notification replay or new-role visibility is
created. Previously documented date omissions and unspecified-currency limitations
remain model/schema limitations, not claims that every field is complete.

The release policy is `full-metadata-2026-10-v1`. Without profile-bound owner
approval, the existing natural-production quality gate and manual review rules
below remain mandatory. Disabling or restoring the prior policy stops new full
release receipts; it does not erase facts that have already been published.

Explicit replacement is separate from normal enrichment. `publish-approved`
accepts `replaceExisting: true` only when the exact cohort approval contains
`replaceExistingMetadata: true`, input is complete, every field is validator
accepted, and the request contains the entire publishable snapshot. The current
profile is required even for retries with an existing receipt. A complete empty
snapshot is valid: it clears stale values rather than retaining old pay or tags.
Replacement retires prior metadata evidence and receipts, preserving source
attachments, admission, identity, visibility, and notification history. Partial
or incomplete refreshes cannot erase accepted metadata.

The owner-approved October seven-day refresh has an $8 total ceiling, raised
from $5 without resetting prior spending. At the original approval
the ledger committed 1720 cents globally, including 877 historical cents. An
explicit headroom binding of `2520` permits at most 800 more committed cents
from that original baseline, with historical spending capped at 1677 cents.
The earlier `2220` binding retains the original $5 grant. Reservations and concurrent
traffic count against these ceilings. The special allowance applies only in
October 2026; other months retain the prior limits. The runner also caps its
own task at 500 cents and must report unprocessed or unavailable roles rather
than claiming that every role in the window was refreshed.

### Previous prospective policy

The preceding policy was `prospective-provider-poll-2026-09-v1`, starting at
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
