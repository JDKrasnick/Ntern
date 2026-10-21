# Opportunity ranking

The public catalog defaults to **Best opportunities**. **Newest** remains a
separate chronological sort. The main web Catalog feed and Search share the selected
query, sort, date window and facets, including role focus. New web installations and
legacy preferences start with **Last day** (the last 24 hours) and **Best opportunities**.
Readers can choose Last week or All independently of the ranking. Both sorts
respect the same role, employer, education, source, availability, location and
date filters. Ranking never changes admission or notification eligibility.

The catalog uses a compact filter toolbar: company/role search, time window
and sort sit on one horizontal row on wide screens. Narrow screens keep time
and sort together below the search field. Results use continuous compact rows;
the feed header has no swipe action or scoring subtitle.
The Roles control opens the existing facet sheet; selected role types and other
facets apply to every feed page, while Best and Newest sort the matching roles.
The layout changes apply only to web, including narrow browser widths. Native
navigation, feed cards, catalog rows, search controls and their existing styles
retain their previous presentation. Native freshness controls, Newest default
and v1 preferences also remain separate from the web migration. Web compares season and education in plain
columns, with education labels separated by a slash (for example Undergrad / Masters).

## Web application history

A successful Apply handoff saves the role and opening time in this browser's
History tab and removes that role from Catalog, Search and grouped-role details.
Opening a form is labeled as an opened application, not proof of submission.
Invalid links and blocked popups do not create history or hide the role. Other
roles in the same group stay available: the client loads the group's remaining
roles when its previous representative moves to History. Browser history persists
across reloads and works without an account; it does not claim cross-device sync.
Signed-in History also includes existing tracked applications, and the web Queue
keeps only roles still waiting in the queue. Native presentation stays unchanged.

## Score v1

Each role receives a shared score from 0 to 100:

`0.45 × company + 0.30 × pay + 0.25 × role fit`

Freshness contributes **zero** points, including tie-breaking. Equal scores
use stable group/role IDs. Last day, Last week and the release calendar narrow
the candidate set separately. Observation-time windows use an inclusive UTC
lower/upper bound, pinned when selected and preserved across pagination.

- **Company:** 70% career/technical reputation and 30% business strength.
  `src/company-ratings.ts` contains nine initial editorial assessments, their
  official sources, aliases, rationales and review dates. Scores interpret the
  evidence; they are not externally measured prestige, guarantees of internship
  quality, or investment ratings. Unknown employers receive 50, independently
  of employer category, application platform, company-name length or link shape.
  Initial reviewed coverage is deliberately limited; an unrated employer is not a bad one.
  Expansion follows the hybrid policy: gather primary evidence, propose a score
  under the rubric, then review major employers and uncertain cases in a normal
  reviewed repository change. No external company lookup runs on catalog requests.
  The existing `src/config/weights.ts` company tiers provide the active simple
  fallback, marked `companyEvidence: lookup`: 100, 80 or 60 points, with exact
  normalized names and explicit aliases. These are presets, not newly researched
  ratings. Reviewed scores take priority. Unknown companies stay neutral at 50.
  An optional People Data Labs lookup supplies a cached company-size fallback,
  marked `companyEvidence: size`, after both tables. Employee counts below
  50 score 50, 50–199 score 55, 200–999 score 65, 1,000–9,999 score 75, and
  10,000+ score 85. This is a rough company-size proxy, not a prestige assessment.
  A checked-in public company-size snapshot supplies a fallback when the cache
  has no valid score. Missing, unsupported, or unresolved employers stay neutral at 50.

- **Pay:** use the disclosed minimum base pay, never the maximum of a wide range.
  Missing, invalid, unsupported, ambiguous, multiple, degree-specific or
  location-specific bands receive 50. Housing, bonuses and equity are excluded.
  Hourly and annual pay compare using 2,080 hours/year; this is a scoring
  convention, not expected internship earnings. Other periods stay neutral.
  A scalar normalized USD minimum remains usable for older catalog entries.
  Pay text alone is not parsed again by the scorer.
- **Role fit:** a technical early-career title/program scores 90, one of those
  signals scores 70, an unclear role scores 50, and a senior title without
  early-career evidence scores 20. Supported technical disciplines are treated
  equally. This measures fit with the product's audience; descriptions are not
  available here to substantiate mentorship, team quality or learning outcomes.

Pay anchors are **provisional editorial policy**, not observed market
percentiles. Each currency has independent hourly anchors at 0/50/100 points:

| Currency | 0 | 50 | 100 |
| --- | ---: | ---: | ---: |
| USD | 15 | 35 | 90 |
| CAD | 16 | 30 | 65 |
| GBP | 10 | 20 | 50 |
| EUR | 10 | 22 | 55 |

Scores interpolate linearly and clamp to 0–100. These broad currency buckets
do not yet adjust for cities, living costs or role-specific salary distributions.
Unsupported currencies stay neutral. “Higher listed pay” means at least 70 under
this policy, not a verified market percentile. Calibrate these anchors against a
reviewed catalog sample before a production rollout.

### Offline company-size lookup

`src/config/company-size-snapshot.json` contains 474 unique exact normalized-name
and existing employer-domain matches from the full 32,330,231-record public
[company dataset](https://huggingface.co/datasets/andreaaltomani/company-dataset).
It is attributed to Andrea Altomani and the original People Data Labs free company
dataset under CC BY 4.0. The pinned revision, SHA-256, upload date, catalog snapshot
date, domain and provider ID are retained with the derived subset. The source was
uploaded August 4, 2025; employee bands can be older. Size is a rough proxy, not
a measured career-value or prestige rating.

Reviewed ratings and existing tiers take priority, then a valid live-provider
cache score, then the offline size band, then neutral 50. The size band's lower
bound uses the same employee-count rubric as the optional provider. Domain-only,
name-only, ambiguous, conflicting and missing records are excluded from this
snapshot; being unresolved is not evidence that a company is weak. No dataset
download, third-party request or API key is needed to rank the catalog.

The October 21, 2026 audit covered 1,290 company names and 5,416 roles. The accepted
subset covers 2,645 roles; together with existing ratings/tiers it covers 2,998
(55.4%). These are match-coverage figures, not independently measured precision.
Spot checks rejected Klaviyo/LumApps, F5/F5 LLC and Johnson & Johnson/insurance
matches, demonstrating why provisional matches must not be accepted automatically.
Refresh the offline audit and run
`npx tsx scripts/import-company-size-snapshot.ts <audit.json>` in a reviewed
repository change to update the subset. New source revisions require an explicit
provenance update in the importer. Numeric scores and component explanations
remain internal to web ranking; the web catalog and grouped-role sheet do not
display them. Native presentation is unchanged.

### Optional live company-size lookup

The server-only `PDL_API_KEY` secret and `COMPANY_SIZE_LOOKUP_ENABLED=true` are
both required. The flag defaults off and remains off while provider access is
unavailable. A configured key alone makes zero provider requests. Never put the
key in mobile configuration or commit it. Provision it only on the ingestion
Worker; the API Worker reads the shared cache and forwards operations privately.

The existing ten-minute icon maintenance schedule processes up to five distinct
open-catalog employers after checking D1 pressure. It uses a known employer
website domain when available, never an ATS host. Domain matches require
likelihood 6 and an exact matched website; name-only matches require likelihood
5 and an exact normalized name. Requests use the fixed PDL endpoint, an eight-second
timeout, a 16 KiB response limit, and no automatic retries or redirects.

Migration `0058_company_size_cache.sql` persists results independently of jobs.
Matches last 30 days and no-match results last seven days. A shared lease prevents
concurrent paid refreshes. Any provider error stops the batch and pauses further
refreshes for an hour. Catalog reads use one score snapshot for both global
ranking and selected-page hydration; cache failures retain the offline subset
and neutral fallback.

Operations-key protected endpoints:

- `GET /internal/company-sizes`: all open-catalog employer names, role counts,
  cache coverage and configuration presence, without credentials.
- `POST /internal/company-sizes/refresh` with `{ "limit": 5 }`: refresh at most
  25 due employers. A disabled flag means `skipped: disabled`; no key means
  `skipped: missing-key`. Both make zero paid calls.

`npx tsx scripts/audit-company-sizes.ts` audits all pages of the live public
catalog, saves a reproducible snapshot under `.context/`, and checks each
representative against every fallback band. It reports synthetic scenarios
separately from real provider coverage and performs no paid provider lookups.

## Grouping, paging and explanations

Filters run before ranking. A group's score is its best matching role's score;
that role leads the detail list and becomes the representative. More postings
do not add points. Reasons such as “Strong employer”, “Higher listed pay” and
“Technical early-career role” come from the actual components. Unrated company
and unknown-pay statuses remain explicit in the API response.

D1 scans compact comparison signals in keyset pages of 100 groups, retaining
only group IDs, row keys and scores; only the selected page's full cards are
hydrated. Descriptions, provenance graphs, source references, pay excerpts and
URLs are excluded from the scan. This works with existing projections without
a migration, rewritten ingestion rows or an R2 republish. Live overlay cards
replace fully covered published cards and join the global rank order instead
of being prepended. Admission is rechecked by the API after hydration.

R2's chronological pages remain the Newest path. Best uses D1's compact scan;
its query work scales with the filtered catalog per request. This avoids
whole-catalog hydration but is not an indexed constant-cost rank lookup.
Measure representative production-size latency/rows-read before enabling a
public release; a compact published rank index is a future optimization if
needed. Offset pagination retains existing semantics: changes to catalog data
between requests can move entries, and the client deduplicates appended cards.

## Validation and rollout

Regression coverage compares D1, in-memory and fallback API ranking, checks
page boundaries and live overlays, tests filter-before-score behavior and
neutral/malformed pay, and limits full-card hydration. Mobile tests cover
default sort, stored preferences and date-window propagation.

The 2026-10-20 isolated dev validation deployed all four Workers and verified
their control profiles. Public reads returned descending scores and respected
the pinned 24-hour bounds. The first 50 matching groups included reviewed
employers, unrated employers and missing compensation; unknown company and pay
signals stayed neutral. The sample exposed Amazon's legal employer name,
Amazon.com Services LLC, which is now an exact reviewed alias. A last-day Best
request took 1,171 ms cold and 498 ms warm; Newest took 608 ms. An all-time Best
request took 2,349 ms. These are smoke observations, not a latency guarantee or
a calibrated market study. The provisional pay rubric remains explicit policy;
monitor the compact scan's latency and D1 reads as catalog size grows.
