# Company icons

Company icons are stored against `canonical_employers`, not provider mappings or a company website domain. The asset lives in the existing `DOCUMENTS` R2 bucket under `company-icons/<canonical-employer-id>/...`; the D1 `icon_key` is the only public reference.

## Operator workflow

For a reviewed square PNG, WebP, or AVIF, use a lowercase canonical ID containing only letters, digits, and hyphens, such as `acme`, and an immutable filename such as `logo-v1.webp`. Upload the asset to the existing documents bucket, then attach that exact key while creating or updating the employer. The API rejects a key outside that employer's `company-icons/<id>/` prefix, and rejects a new employer without a key. SVG is not served because opening an SVG directly can run scripts on the API origin.

```bash
# The bucket name is derived from the API worker name: intern-notifs-documents.
npx wrangler r2 object put intern-notifs-documents/company-icons/acme/logo-v1.webp \
  --file ./reviewed-assets/acme-logo.webp \
  --content-type image/webp

# Keep the operations key out of history. This records the reviewed R2 key in D1.
read -s OPERATIONS_SHARED_SECRET
curl --fail-with-body --silent --show-error \
  -X PUT https://intern-notifs.jdkrasnick.workers.dev/internal/admission/employers \
  -H "X-Operations-Key: $OPERATIONS_SHARED_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"id":"acme","displayName":"Acme","iconKey":"company-icons/acme/logo-v1.webp","reason":"Reviewed company icon"}'
unset OPERATIONS_SHARED_SECRET
```

Backfill existing canonical employers manually with this workflow. Keep the original display name, mapping, and reviewer record. A new canonical employer submitted through the operations API must include an `iconKey`; this prevents silently adding another unbranded company.

To withdraw an existing employer's icon, send the same authenticated `PUT /internal/admission/employers` request with its `id`, current `displayName`, and `"iconKey": null`. The operation clears the reviewed D1 reference; `/company-icons/<id>` then returns 404 with `Cache-Control: no-store`. Omitting `iconKey` preserves the current icon. The R2 object can be removed separately after the D1 reference is cleared.

Do not derive branding from arbitrary websites or third-party favicon services. A website domain may be recorded later as provenance, but it is not needed to store, serve, or validate an icon.

## Live resolution

Most canonical employers are created before anyone has an icon for them, and a role must never wait on one. An employer without a reviewed icon therefore gets a background decision, and every unresolved case renders the deterministic monogram the client already draws. A role published without an icon is never hidden and never delays a notification.

### How a decision is made

1. **Admission records the task.** When posting admission resolves a canonical employer, `src/poll.ts` hands the employer ID, the application URL, and the provider/tenant to `enqueueEmployerIconResolution`. That is one deduplicated `INSERT` keyed by `(canonical_employer_id, evidence_fingerprint)`; no provider or model is called on the ingestion path, and the insert is skipped when the employer already has a reviewed icon or a live decision.
2. **A sweep resolves it.** The ten-minute maintenance cron calls `runEmployerIconResolutionPass`, which claims at most `maxPerSweep` due rows with a lease. The sweep reads the real application link through the existing SSRF controls (`safeFetchText`, five redirects, 10s, 512 KiB), parses only bounded public metadata (`<title>`, OpenGraph, JSON-LD `Organization` name and URL), and asks Logo.dev and Brandfetch for domains by employer name. A posting page larger than the ceiling is **truncated, not rejected**: the employer's name is in the first few kilobytes of `<head>`, and a two-megabyte Lever page must not cost that employer its icon.
3. **Scoring decides.** Candidates are scored from the reviewed table — non-ATS final/careers URL 0.45, the reviewed application host of an officially-admitted role 0.40 on top of that, JSON-LD Organization 0.35, each provider's exact-name candidate 0.30, both providers agreeing on one domain 0.25, employer-identity evidence naming the employer 0.15, capped at 1.0. ATS and job-board hosts are transport and are rejected outright. A domain is accepted automatically only at 0.85 or above with a 0.15 margin over the runner-up.

   The 0.40 exists because a role admitted from an official ATS, structured, or employer-submitted source has already had its destination reviewed as the employer's own application form. If that form is served from a host that is not a transport platform, that host *is* the employer's application host, and nothing further needs to confirm what the catalog already established. Community listings are deliberately excluded: their links are not the employer's own destination. Scores are settled to six decimals before the threshold comparison, so `0.45 + 0.40` cannot miss 0.85 to a binary rounding error.
4. **One tie-breaker for the middle band.** The resolver may make **one** schema-validated `gpt-4o-mini` call when the best score is in 0.55–0.84, when the top two candidates are within 0.15, or when the best candidate already carries two independent evidence IDs (a candidate the tie-breaker could actually accept, since its own rule requires exactly that). It receives only a compact JSON summary, may select only a submitted candidate, must cite at least two distinct evidence IDs that belong to that candidate, and must reach 0.90 confidence. Anything else downgrades to a monogram. The budget is one call per employer per 30 days, except when the job-link evidence materially changed.
5. **Failures back off.** A definitive no-match retries from one day, doubling to the 30-day revalidation ceiling. A transient provider failure (429/5xx/transport) retries from one hour and honours `Retry-After`.

### What the evidence can and cannot prove

Two posting shapes carry very different evidence.

**On the employer's own domain** (a direct careers link, or an employer-hosted ATS riding a vanity host): the link itself proves the domain, and the page usually confirms the employer in its title, OpenGraph, or structured data. A Workday-backed role that starts on `jobs.intel.com` and redirects into a Workday host resolves to `intel.com` off the redirect chain, and the Workday host is rejected as transport.

**On a platform host** (`job-boards.greenhouse.io`, `jobs.lever.co`, `jobs.ashbyhq.com`): the page proves *which employer is hiring* — the title usually ends in `at <Employer>` — but never names the employer's domain, because the host is transport. Here the provider's nomination carries the domain and the page carries the identity.

Four kinds of employer-identity evidence are collected, and any two are enough to send one candidate to the tie-breaker:

1. **The posting page** naming the employer in `<title>`, OpenGraph, or JSON-LD Organization. Compared after corporate suffixes *and* organizational qualifiers are removed, so a page showing the brand alone still counts for a catalog name like `Palantir Technologies` or `Flagship Pioneering Co-Op Program`.
2. **The structured Organization block**, whose domain is read from `url` *and* `sameAs`. Publishers routinely use `sameAs` for an Organization's site — Stripe's own `hiringOrganization` does — and reading only `url` left this entire 0.35 evidence class dead in production. A profile URL in `sameAs` is collected but can never become a candidate, because social platforms are transport.
3. **The provider's own reported brand name**, matched symmetrically: it must contain every distinctive employer term and add no distinctive term of its own. `Flagship Pioneering` describes `Flagship Pioneering Co-Op Program` and `IMC Trading` describes `IMC`; `Scale Computing` never describes `Scale AI`.
4. **The posting's reviewed ATS board slug**, compared against the canonical employer ID on whole segments and affixes from four characters. It is independent of whatever domain a provider nominates, and it carries the case where the page is challenge-gated or names an agency (`axontalentcommunity` hosts `axon`).

Each provider is searched twice when the first attempt finds nothing: once with the full catalog name and once with the employer's distinctive brand token, because real catalog names are not what a search index holds (`Flagship Pioneering Co-Op Program` versus `Flagship Pioneering`). Both attempts use the same exact-name rule, so a retry can only recover a nomination the shorter query legitimately matches.

Identity evidence is attached to a domain the page itself named, or, when it names none, only to the candidates a **provider** nominated. It is never attached to an arbitrary host, so it cannot vouch for an unrelated domain, and a page naming a *different* employer contributes no page evidence at all.

A platform domain is normally rejected outright. One narrow exemption keeps the platform owners reachable: `employerNamesDomain` unblocks the host when the employer's own name denotes it, so `google.com` is reachable for Google, `github.com` for GitHub, and `rippling.com` for Rippling, while `greenhouse.io` stays unreachable for anyone but Greenhouse.

**Automatic resolution still requires two independent identifiers**, because the tie-breaker may only accept on that basis. A page cannot be the only evidence, and neither can a lone provider nomination.

### Measured

Two cohorts from the live catalog, driven through the real resolver over real application links, with real page fetches and the real reviewed board slug read from each board URL. Providers and the image endpoint were deterministically simulated, because no provider credential was available; provider *hit rates* therefore remain unmeasured, but every scoring, attribution, threshold, and validation rule is real. **Every expected domain was verified by fetching it and confirming it names that employer** — which corrected several of my own guesses, including that the Rivian/Volkswagen venture is `rivianvw.tech` and not `rivian.com`, and that `pylon.com` and `basepower.com` belong to *different* companies than Pylon and Base Power.

| Cohort | Providers | Model | Published | Correct | Incorrect |
|---|---|---:|---:|---:|---:|
| Own domain (28) | none | no | 3 | 3 | **0** |
| Own domain (28) | none | yes | **28** | **28** | **0** |
| Own domain (28) | Logo.dev | yes | 28 | 28 | **0** |
| Own domain (28) | Logo.dev + Brandfetch | yes | 28 | 28 | **0** |
| Platform host (26) | none | yes | 5 | 5 | **0** |
| Platform host (26) | Logo.dev | yes | 26 | 26 | **0** |
| Platform host (26) | Logo.dev + Brandfetch | yes | 26 | 26 | **0** |

The own-domain cohort is complete **without any provider at all**. Before the reviewed application host counted, eight employers — Coinbase, Jump Trading, Jane Street, Goldman Sachs, OpenAI, Uber, Tesla, and Google — were stranded at 0.45 with a single evidence ID, so they rendered a monogram even though their own application link was in hand. They now resolve automatically at 0.85.

Four platform-hosted employers are excluded from the denominator because no domain of theirs could be verified at all; they are program or confidential boards (`walleyecapital-external-students`, `samsungresearchamericainternship`, `stackadapt-confidential`, `toshiba-global-commerce-solutions`).

Read across: a role on the employer's own domain needs no provider, and a platform-hosted role needs one. Provider consensus resolves every platform-hosted employer automatically, and Logo.dev alone reaches all of them through the tie-breaker. Provider-free operation on a platform host is deliberately partial: a posting whose page declares nothing yields a monogram and no wrong domains.

**No incorrect domain was published in any configuration.** Every evidence signal and every decision path was exercised by the run:

| Signal | Times present on the winning candidate |
|---|---:|
| `page-title` | 120 |
| `final-url` | 110 |
| `logo-dev` | 108 |
| `opengraph` | 68 |
| `ats-tenant` | 57 |
| `brandfetch` | 54 |
| `redirect-host` | 34 |
| `jsonld-url` / `jsonld-name` | 29 each |

Decision paths taken: automatic resolution, tie-break acceptance, and monogram fallback, all in both cohorts.

### Provider terms

- **Logo.dev** supplies both the name search and the icon. The credential is a Worker secret (`LOGO_DEV_TOKEN`), never an `EXPO_PUBLIC_*` value, and never appears in a response, an R2 key, or a log.
- **Brandfetch** is corroboration only. Its standard Brand Search terms forbid persisting its data, so its results are used in memory, are never written to `employer_icon_resolutions`, and its logo is never fetched or stored. Only a bare agreement flag is recorded, and a candidate that only Brandfetch nominated is omitted from the stored evidence.
- **Simple Icons and favicon services are not used.** The mobile client previously carried a hardcoded map of `cdn.simpleicons.org` and `icons.duckduckgo.com` URLs; it has been removed in favour of the first-party route and the monogram.

### Serving an automatic icon

`GET /company-icons/:id` resolves in this order:

1. a reviewed `icon_key` in `DOCUMENTS` (unchanged from the workflow above);
2. an automatically resolved domain, fetched server-side from the provider CDN and returned with the same security headers.

The second path exists so a provider credential never reaches a client, a catalog payload, or a stored key, and image bytes are **not** written to R2 while Logo.dev self-hosting rights are unconfirmed. The image probe requests `fallback=404`, so Logo.dev's generated monogram tile can never be served as if it were a real logo. Responses keep `max-age=60, must-revalidate`, so a wrong-icon report takes effect within a minute.

Once the Logo.dev plan confirms self-hosting and retention, record the confirmation and the resolver will cache the icon instead:

```bash
curl --fail-with-body --silent --show-error \
  -X PUT https://intern-notifs.jdkrasnick.workers.dev/internal/admission/employer-icons/settings \
  -H "X-Operations-Key: $OPERATIONS_SHARED_SECRET" -H 'Content-Type: application/json' \
  -d '{"mode":"resolve","maxPerSweep":5,"logoDevRetentionLicensedAt":"2026-10-01T00:00:00.000Z"}'
```

That writes an immutable `company-icons/<id>/logo-<hash>.webp` key and sets `icon_source = 'logo-dev'`.

### Operator surface

All routes require the `X-Operations-Key` secret and return `Cache-Control: no-store`.

| Route | Purpose |
|---|---|
| `GET /internal/admission/employer-icons` | Settings, resolution counts by status, the exception queue, and which providers are configured. |
| `PUT /internal/admission/employer-icons/settings` | `mode` (`off`, `observe`, `resolve`), `maxPerSweep`, and the retention confirmation. |
| `POST /internal/admission/employer-icons/resolve` | Force a fresh decision for one employer, and re-arm one whose automatic decision was withdrawn. |
| `POST /internal/admission/employer-icons/confirm` | Settle one employer by hand with a bare hostname. Rejects an ATS or job-board host and refuses a domain with no real logo, so a person can name a domain but never vouch for a broken icon. |
| `POST /internal/admission/employer-icons/report-wrong` | Withdraw an automatic icon immediately and sort the employer to the front of the exception queue. A reviewer-uploaded icon is never withdrawn. |

A wrong-icon report is deliberately terminal for the automatic path: the sweep will not re-decide that employer until a person has looked at it. Once the review is finished, `resolve` re-arms the withdrawn rows, and the next sweep decides again from fresh evidence.

`mode` is stored in `system_state`, not in Wrangler, so enabling the resolver never changes a Worker binding and the deploy plan guard stays clean.

### Staged rollout

1. `npm run cloudflare:migrate:remote` — apply `0034_employer_icon_resolution.sql` **before** deploying the Worker. The resolver and the employer upsert both read the new columns.
2. Provision the secrets: `npx wrangler secret put LOGO_DEV_TOKEN --config wrangler.ingestion.jsonc` and `npx wrangler secret put BRANDFETCH_CLIENT_ID --config wrangler.ingestion.jsonc`. Both are needed to publish at scale: consensus is what clears the automatic threshold, and Logo.dev alone publishes only where the posting page independently names the employer. Set `OPENAI_KEY` if it is not already present; without it the resolver skips the tie-breaker and falls back to the monogram. Terraform keeps `secret_text` bindings, so these survive deploys and never appear in a plan.
3. `tsx scripts/discover-employer-icon.ts --employer a,b,c` over about twenty employers spanning large companies, niche startups, quant firms, public companies, community listings, and challenge-gated sites. It is read-only and writes nothing. Record domain accuracy, the Logo.dev hit rate, the Brandfetch corroboration rate, the monogram rate, and the tie-break count.
4. Set `mode: "observe"` and leave it there for a week. Decisions, provenance, and counters are recorded, but readers still see only reviewed icons and monograms.
5. Switch to `mode: "resolve"` once the automatic false-match rate is acceptable. Reviewed icons are unaffected, and `report-wrong` is the immediate withdrawal path.
6. Enable R2 caching only after Logo.dev confirms self-hosting and retention rights for the selected plan.

### Observability

The sweep emits one structured line per pass, `company_icon_resolution_complete`, carrying `company_icon_resolution_attempted_total`, `..._resolved_total`, `..._monogram_total`, `..._retryable_total`, `..._backfilled_total`, `company_icon_resolution_provider_outcomes`, and a reason-code tally. The provider outcomes are the honest measure of a provider's real hit rate: `logo-dev:nominated`, `logo-dev:miss`, `logo-dev:failed`, and `logo-dev:unconfigured` are counted separately, because a miss and an unconfigured provider both yield no candidates and would otherwise be indistinguishable. Each accepted or declined tie-breaker also emits `company_icon_resolution_tie_break` with `accepted` and the validation reason code. Token counts are stored per employer in `icon_tie_break_input_tokens`/`icon_tie_break_output_tokens`. Provider tokens, full pages, and raw provider payloads are never logged.

### Reviewing the work without a live host

```bash
# Candidate order, scores, decision, and tie-breaker for real employers.
tsx scripts/discover-employer-icon.ts --employer acme,globex

# One hand-supplied shape, no database read.
tsx scripts/discover-employer-icon.ts --name "Acme" --url https://job-boards.greenhouse.io/acme/jobs/1 --json
```
