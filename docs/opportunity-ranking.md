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

- **Company:** the tier recorded on the canonical employer during admission:
  Exceptional (95), Strong (85), Established (70), or Unrated (neutral 50).
  The editorial rubric blends technical-career reputation with business substance;
  it is not an investment rating, a measured prestige index or a promise about
  each internship. A reviewer supplies a reason, evidence links and exact aliases.
  Headcount, company-name length and application platform contribute no points.
  Automatically introduced and not-yet-reviewed companies stay neutral.

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

### Company ranking at admission

Migration `0059_company_admission_ranking.sql` adds `ranking_json` to
`canonical_employers`. Every existing or automatically added employer starts
with an explicit Unrated/Pending assessment. Ranking does not change identity
verification, catalog admission, source ownership or notification eligibility.

New reviewer-created employers require `ranking` on
`PUT /internal/admission/employers`, alongside the existing identity/icon fields.
Existing icon-only updates preserve the assessment. Employer portal members
cannot set their own tier; these operations require the operations credential.

A ranking review has `tier`, a 10–500 character `reason`, up to ten HTTPS
`sources` (at least one for a rated company), and up to forty exact `aliases`.
The API stamps `reviewedAt` and `reviewedBy`; client-supplied stamps are ignored.
The sources establish employer identity/business context; the tier expresses
editorial judgment. No company-size service or LLM is used.

Review without changing identity or icon metadata:

```json
{
  "ranking": {
    "tier": "strong",
    "reason": "Established technical product business with recognized engineering work.",
    "sources": ["https://www.adobe.com/about-adobe.html"],
    "aliases": ["Adobe Inc"]
  },
  "onlyUnreviewed": false
}
```

Send this to `PUT /internal/admission/company-rankings/<canonical-employer-id>`.
`onlyUnreviewed: true` atomically skips an existing reviewed assessment, including
one changed after the backfill inventory was read. Reviews create an operations
audit decision. A pending ranking never hides an otherwise eligible role.

The initial backfill is a reviewed seed roster in
`scripts/company-ranking-seeds.ts`, with aliases, evidence URLs and rationales.
It corrects the old low presets for employers such as Salesforce and Adobe,
and recognizes explicit legal/brand labels such as Anduril Industries. Employers
outside that roster remain explicitly neutral and pending; they are not falsely
marked as manually reviewed. The migration backfills the neutral state for all
registry rows; the command below applies the recognized tiers. Dry runs write an
inventory/report under `.context/`; credentials stay in untracked `.env`.

```sh
npx tsx scripts/backfill-company-rankings.ts --api https://api.ntern.app
npx tsx scripts/backfill-company-rankings.ts --api https://intern-notifs-dev.jdkrasnick.workers.dev --apply --output .context/company-ranking-dev.json
npx tsx scripts/backfill-company-rankings.ts --api https://api.ntern.app --apply --output .context/company-ranking-production.json
```

The command only updates unreviewed rankings and is safe to retry. Reviewer
changes take effect on the next Best request, with no job rewrite or R2 republish.
The API reads only IDs, display names and ranking metadata in keyset pages of
200, reusing one request-scoped map for global sorting and selected-page details.
Canonical employer ID takes priority; a known but unreviewed ID cannot inherit
another employer's same-name score. Roles without an ID can use exact unambiguous
reviewed names/aliases. Conflicting names and unavailable ranking data stay
neutral. Public query parameters cannot supply a company rating.

The old size snapshot and importer are removed. The optional PDL size-cache
operations remain legacy diagnostics and do not influence catalog ranking.
Numeric scores remain hidden on web, and native layout is unchanged.

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
