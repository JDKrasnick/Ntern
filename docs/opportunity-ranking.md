# Opportunity ranking

The public catalog defaults to **Best opportunities**. **Newest** remains a
separate chronological sort. The main Catalog feed and Search share the selected
sort and date window, while Search retains its own facets. New installations and
legacy preferences start with **Last day** (the last 24 hours) and **Best opportunities**.
Readers can choose Last week or All independently of the ranking. Both sorts
respect the same role, employer, education, source, availability, location and
date filters. Ranking never changes admission or notification eligibility.

The catalog uses a compact filter toolbar: company/role search, time window
and sort sit on one horizontal row on wide screens. Narrow screens keep time
and sort together below the search field. Results use continuous compact rows;
the feed header has no swipe action or scoring subtitle.
The layout changes apply only to web, including narrow browser widths. Native
navigation, feed cards, catalog rows, search controls and their existing styles
retain their previous presentation. Web compares season and education in plain
columns, with education labels separated by a slash (for example Undergrad / Masters).

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
  Initial coverage is deliberately limited; an unrated employer is not a bad one.
  Expansion follows the hybrid policy: gather primary evidence, propose a score
  under the rubric, then review major employers and uncertain cases in a normal
  reviewed repository change. No live model calls or unreviewed ratings run on
  catalog requests. Automated evidence collection is not implemented in v1.
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
