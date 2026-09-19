# Employer metadata coverage audit — 2026-09-05

## Latest implementation: extraction v16 — 2026-09-18

Extraction v16 replaces the keyword degree census with an employer-audience scan
and lets the reader's own level decide eligibility. **Not yet deployed, and no
historical re-extraction has been run.** Every stored `education.levels` value
therefore reflects v15 behaviour until its source refreshes.

Why: an audit of the live projection (`CATALOG_PROJECTION#e1fd888f53bbe59a1761`)
found **637 open roles whose stated audience excludes undergraduates**. Only 296
of them carried the `advancedDegreeRequired` badge, so the previous "hide advanced
degree" toggle could not hide the other **341** — including NVIDIA *Developer
Technology Engineering Intern - AI - 2027* (`masters` + `doctoral`), The Home
Depot *Software Engineer Intern* (`doctoral`), and Clearwater Analytics *Software
Development Intern* (`masters`).

The old scan also misread prose. Clearwater Analytics *Gen AI Intern* was stored
as `masters` because the description contains the typo'd action bullet
`Master's the team's business domain basics within 1 month`, while its actual
requirement — `Current students pursuing a four-year degree in Computer Science`
— went unrecognized. The role is undergraduate-eligible and was excluded from
undergraduates.

What changed:

- `educationAudienceLevels` (`src/identity/enrichment.ts`) is now the one audience
  scan used by both role metadata and the posting identity. It works at sentence
  and list-segment scope so `MS preferred, BS required` keeps its requirement, and
  it drops preference-only mentions (`preferred`, `a plus`, `desirable`) and waived
  requirements (`not required`, `no ... degree required`).
- An unqualified `master`/`Master's` counts only when the next token continues a
  degree phrase and the sentence states an audience, which rejects the verb
  readings (`Master the team's domain`, `mastering distributed systems`) while
  keeping `(Master's)`, `Master's, or PhD degree`, and `Master's in CS`.
- Two-letter forms are case-sensitive (`5 ms latency` is not a Master's) and
  require degree context when lowercase. `four-year degree`, `4-year degree`,
  plural `graduate students`, and `graduate program` are recognized.
- Pay rows are labels, not prose, so `payTierEducationLevels` keeps its own scan.
- `ROLE_METADATA_EXTRACTION_VERSION` is 16, which makes the collection scheduler
  revisit every previously-enriched posting.

Eligibility now follows the stated audience rather than a badge, in the catalog
projection read, the in-memory catalog filter, and alert preferences alike:
unstated or conflicting evidence never hides a role, a stated audience that omits
the reader's level does, and the legacy badge only rules out an undergraduate
because it never says which graduate degree it means.

Corpus evidence so far: 17 audience-scan cases including the Clearwater posting
verbatim, SQL/JS parity over stated/unstated/conflicting audiences, and the
existing 1,794 passing backend tests. Production re-extraction, the
undergraduate-eligible retention check, and physical-device validation remain
open.

### Why roles stay unspecified (measured 2026-09-18)

**Correction.** An earlier version of this section claimed the unspecified share
was not an extraction gap, based on a 60-role audit in which only 14 pages were
actually reachable. That audit was too small to support the claim and the claim
was wrong. A provider-aware audit — reading each posting's description from the
provider's own API instead of scraping a rendered page, which raised resolution
from 14/60 to 143/150 — shows the opposite:

| Outcome | Roles | Share |
| --- | ---: | ---: |
| Posting names a level the scan does not extract | 29 | 20% |
| Discusses a degree without naming a level (correctly unspecified) | 45 | 31% |
| Never mentions a degree | 69 | 48% |

Misses by host: Workday 23, iCIMS 5, Greenhouse 1, and none across 19 Oracle,
8 Ashby, 2 SmartRecruiters and 1 Lever. Roughly **20% of the stored open
unspecified roles state a level that is discarded**, and a subset of those state a
graduate-only audience that an undergraduate should not be shown. This is the same
class of defect v16 fixed, reached through a different cause.

The cause is acquisition, not classification. Metadata API collection targets a
role only when its occurrence has a destination admission classified
`posting-detail`/`application-form`, or a confirmed posting identity
(`metadataCollectionTarget`, `cloudflare/catalog-admission-store.ts:118`), and the
role is re-collected only after `ROLE_METADATA_REVALIDATION_MS` (30 days).

Current snapshot (2026-09-19, 5,681 open internships, 4,269 of them unspecified):
applying the real predicate across every reference splits them **3,613
collectible / 656 structurally uncollectible**. By first reference the blocked
classes are: no destination + unconfirmed 227, `blocked-uninspectable` 160,
`aggregate-board` 153, `unresolved` 139, `gone` 5. Earlier revisions of this file
reported 1,344 / 567 of 1,917 — a smaller catalog, and a first-reference count
rather than the predicate.

Two acquisition routes were added since that measurement:

- **iCIMS** (143 open unspecified roles). It publishes no open JSON detail
  endpoint, and its plain job URL is a client-rendered shell: across 25 live
  postings the plain URL carried the description 0 times while the frame route
  (`?in_iframe=1&mobile=false`) carried it 23 times. `metadataApiRoute` now routes
  the reviewed identity to that frame URL, the acquirer accepts HTML for that one
  route, and the parser reads the `JobContent` region with the posting id as its
  identity check. Measured through the real acquirer over 25 live production
  identities: 25 acquired, 13 (52%) state a level. Remaining iCIMS gaps: 40 roles
  where the identity handed to the acquirer is `github`/`unknown`, and 26 with no
  collection target at all.
- **Field-less page evidence with an available API route** now returns to the
  24-hour window instead of the 30-day one, the deferrals already written are
  re-claimed, and a bounded staged collection runs on every maintenance tick.

Blocked classes are not a code gap but a review one. `metadataCollectionTarget`
also accepts a **confirmed posting identity**, and the unreviewed URL families are
enumerated by `reviewFamilyKey` (`src/posting-identity-repair.ts:1099`, surfaced by
`npm run audit:posting-identity`). Among unspecified roles the largest families are
`careers.qorvo.com/job/:segment/:number` (49), `careers.amd.com/jobs/:number?icims`
(69 across three variants), `app.careerpuck.com` (32), `jobs.l3harris.com` (20),
`jobs.smartrecruiters.com` (33), `apply.workable.com` (32) and
`careers.garmin.com/jobs/:number?icims` (15). Confirming a family unlocks
candidacy; the route still needs a recognisable provider host, so vanity domains
such as `careers.amd.com` additionally need their redirect target resolved.

This is not a routing rule keyed to source identity: the same community source
holds roles both with and without API evidence, and 363 roles on already-supported
providers have no extraction attempt recorded at all.

Not a lever: JSON-LD `educationRequirements` and `qualifications` (valid
`JobPosting` properties we do not read) appeared on **0 of 66** sampled postings,
and only 8 unspecified roles carry a degree word in the title.

### What was fixed (2026-09-18)

Two defects let this accumulate silently, and neither was a classification gap:

- **Reaching a page was treated as finishing an acquisition.**
  `persistDestinationAdmission` granted the full `ROLE_METADATA_REVALIDATION_MS`
  (30 day) window whenever the page was complete and the destination classified
  `posting-detail`/`application-form` — even when the page yielded no fields at
  all, which is the case for every role in this cohort. A provider API that would
  have supplied the text therefore went unread for a month. Evidence that
  produced no fields while a provider API route exists now returns on the
  24-hour window; a page that did answer keeps the full window.
- **Collection had no trigger.** `metadataVerificationCandidates` was reachable
  only through `POST /internal/role-metadata/backfill`, and
  `leaseDueVerifications`/`syncVerificationSchedule` are referenced only by tests.
  Every role was therefore collected exactly once, by hand, and then parked. A
  scheduled step now stages a bounded collection each hour in the same
  staging-only mode the operations endpoint uses — a backfill token makes the
  batch consumer stop before any catalog, admission, or notification write — and
  is bounded by `METADATA_SCHEDULED_COLLECTION_LIMIT` (default 100 per pass,
  `0` disables scheduled collection).
- **The month-long deferrals already written stayed in force.** Correcting the
  rule as it is written would only have helped future acquisitions, leaving the
  1,314 already-parked roles waiting out their full window. Candidate selection
  now treats field-less evidence with an available provider API route as due
  after a day whatever deferral the row carries. The exemption is self-limiting:
  it ends as soon as the API supplies fields, which returns the role to the
  normal window.

Publishing the staged evidence still runs through the guarded repair workflow
with its exact token and count checks, so neither fix changes a public job on its
own.

A posting that names no level stays visible to every reader, so these misses do
not hide roles — they mislabel them, and they leave graduate-only roles on an
undergraduate's feed. The filter sheet states the rule directly so the reader is
not left guessing: roles that state a different level are hidden, roles that state
none are still shown.

## Earlier implementation: extraction v14 — 2026-09-07

Worker source `31f278f`, version `155ddb09-e5c6-4d5e-aa27-814cba5e0498`,
is deployed with source-processing revision 2 and production flags preserved.
All 1,430 backend tests and 101 mobile tests pass; type checks, lint, Worker
compilation and PR CI pass. The separate production web deployment remains on
Cloudflare Pages and is not overwritten by this backend rollout.

Full official-response replays retain Magna's six school-year/degree pay rows
and PayPal's three location bands. Unknown currency and Magna's unstated pay
period remain unknown. The Greenhouse source path retains Databricks' regional
bands. Durable legacy 404/410 decisions no longer poison bounded source refresh;
timeouts, blocked requests and persistence failures remain retryable/pending.

At 21:59 UTC, the public catalog still contains 1,643 roles, 418 with pay text,
1,641 with metadata and 22 with housing. The frozen sample still has known
missing disclosures. Fresh v14 collection starts at 97/4,788 current pairs,
not the v13 result of 4,673/4,786. No historical repair is approved or applied.
Source freshness, complete evidence, unresolved conflict reviews, exact repair
approval and public rescoring remain required; see the [current validation
checkpoint](metadata-coverage-plan.md#september-7-validation-checkpoint).

## Earlier implementation: extraction v10 — 2026-09-06

Worker source `eee0205`, version `cb3feb19-bc79-4110-94b0-5a416896aba4`,
is deployed with publication flags independently verified unchanged. Web source
`9e55df6`, deployment `6af88108.internnotifs.pages.dev`, serves the canonical site.
At 20:45 UTC, 1,685 public roles include 409 with pay (24.3%), 1,379 with enriched
metadata (81.8%), and 21 with housing information (1.2%). These are field-presence
counts, not disclosure recall, numeric housing-cost coverage, or proof of repair.

Live QA found seven Varda roles with a $20 cell-phone reimbursement in the salary
display. V10 binds reimbursement exclusions to the individual monetary clause.
All seven exact employer payloads now replay through ordinary ingestion with
one USD 33/hour wage, the relocation-conditional housing stipend, and zero
conflicts. The original 53-posting corpus still retains pay throughout with zero
reproduced conflicts; all 19 SpaceX source-path cases retain pay too.
The 20:45 public snapshot confirms all nine current Varda roles exclude the
reimbursement: eight show USD 33/hour, Flight Software shows USD 37/hour, and
all nine retain conditional housing separately after the ordinary 20:43 refresh.

The new extraction version requires fresh evidence. Its initial audit starts at
0/4,645 current source/posting pairs, with 3,434 deferred projections. V9's 95.6%
collection coverage is not v10 validation. Existing public projections remain
accepted-but-stale until their sources refresh; historical collection only
stages evidence. No historical repair is approved or applied. Version-bound
omission reviews must be regenerated before any historical publication.
Exact-cohort comparison confirms all 45 prior pay-loss roles display pay again
at 20:45, up from 43 at 20:24. Recovery of field presence does not prove accuracy:
two TikTok roles display community $60/hour while rendered official-page browser
evidence gives $42.75/hour and $45–60/hour respectively. Jump displays community
USD 138/hour alongside official 250,000/year with unstated currency. Cross-unit
and unknown-currency ranges occupy separate reconciliation groups, so this
source-authority case needs further validation before rollout acceptance.

Web QA also fixes invisible guest catalog controls in the keyboard order,
missing radio/filter states, and a clipped company-coverage toggle. Direct ARIA
props work in both installed renderers; a regression test checks the real web
renderer and actual JSX wiring. Browser confirmation passes at 1440, 390 and
320px, including Profile, Saved, and the sign-in overlay. The native appearance
and inactive-list behavior remain unchanged; physical-device acceptance is open.

Validation: 1,362 backend tests pass (284 skipped), 100 mobile tests pass, both
type checks and lint pass, and Worker compilation/web export succeed. The code
commits' CI checks pass. No account or notification data changed in these checks.

## Previous implementation: extraction v9 — 2026-09-06

Worker source `fba716c`, version `1f9364cf-1f09-499e-be5f-8db386b68767`,
serves 100% of production traffic as of 19:27 UTC. Migrations 0018–0019 are
applied; production publication flags remain unchanged. Web deployment
`e52e8436.internnotifs.pages.dev` serves `internnotifs.app` with separate housing
rows and corrected icon assets. At 19:27 UTC the public catalog has 1,685 roles:
247 with pay (14.7%), 1,164 with enriched metadata (69.1%), and zero with published
housing. Staged evidence is not an applied coverage gain.

The earlier pay count fell from 270 to 224 during ordinary refreshes. Comparing
the September 5 snapshot with the 19:06 catalog confirms 45 still-live roles lost
pay while retaining version-7 SpeedyApply evidence. A current-version refresh
from another source filtered that evidence out and treated the absent projection
as withdrawal. Accepted projections now wait for their contributing snapshots
to be re-extracted or removed; stale evidence is not promoted into a new result.
Those 45 roles remain blank at 19:25; the later rise to 247 is not their recovery.

Source checkpoints separately record the extraction version and preprocessing
revision. A parser upgrade requires one successful full source reconciliation
before conditional ETags/hashes resume. Failed refreshes, HTTP 304s and admission
migration slices cannot mark the replay complete. `deferredProjections` exposes
accepted fields waiting for source refresh and blocks historical apply, even if
destination collection alone is complete.

Ordinary ingestion now preserves paragraph/list boundaries for metadata while
retaining existing admission/lifecycle classification text. All 19 SpaceX
postings from the latest conflict sample retain pay and produce zero conflicts
when replayed through source preprocessing revision 1. This fixes the source
path's flattened pay tiers without restarting version-9 API collection.
Historical browser collection can acquire a newly observed exact Greenhouse
embed through the existing fixed-host API checks, and collision detection cannot
write another job's admission. Tower's live retry remains behind its existing
September 7 backoff; the route is regression-tested, not yet production-rechecked.

V8 adds separately provenanced housing stipends, employer-paid housing, intern-paid
housing costs and availability with unconfirmed cost. Amounts retain their stated
currency and period; conditional or combined benefit amounts remain in the
bounded employer wording when they cannot be isolated safely. Housing never
becomes base salary. Interview/disability accommodations are excluded. The role
detail UI displays housing independently, including conditions and the excerpt.

The v8 production canary exposed adjacent Ashby hourly bands followed by
“Eligible for housing stipend”. V9 separates bullet/pipe-delimited benefits,
leaving stipend eligibility without mislabeling the salary as a housing amount.
It also avoids equating generic housing support with available accommodation and
keeps qualification/relocation conditions explicit. Housing amounts combined
with travel, relocation or other compensation remain unquantified.
Production v9 canaries confirm both the RV Tech correction and Melius's separately
stated USD 2,500/month housing stipend. Omission preview succeeds with zero public
writes. The owner approved both Melius omission decisions at 18:39 UTC, changing
zero public jobs. Later evidence invalidated the Spring/Summer 2027 decision's
fingerprint; its renewed preview awaits approval. No historical repair is approved
or applied.

Validation: 1,351 backend tests pass (284 skipped); root type checks, lint and the
Worker build pass. Earlier unchanged-client validation has 94 mobile tests,
mobile type checks and production web export passing. Focused synthetic housing review passes on iPhone, XXL Dynamic Type
and iPad; Android, hardware, VoiceOver and native live-pay acceptance remain open.

General correctness fixes keep graduate audiences separate from graduation dates,
preserve degree alternatives and waived requirements, reject impossible calendar
dates, retain explicit deadline timezones, and distinguish technical titles such
as “Remote Sensing” from actual remote-work qualifiers.

Additional pay regressions cover regional exceptions, structured Greenhouse band
units, spaced thousands/currency codes, adjacent minimum/maximum fields, Workday
start/end labels and explicit lower-bound starting rates. The original 53-posting
API replay still retains pay on every posting with zero reproduced conflicts.
In the final 44-response API sample, only two Melius postings retain conflicts:
the API declares USD 11,000/month while the description separately declares
8,500 salary and 2,500 housing stipend. No salary winner is inferred.

An operations-only reviewed-omission workflow requires an exact approved review
token, then a separately approved repair token/counts. Review approval changes no
public job. Activated omissions expire when versioned evidence changes. Migration
0018 adds the ledger and an atomic revision guard. Migration 0019 scopes review
approval to the posting's revision without weakening the catalog-wide repair
guard; unrelated conflicts and the full collection gate remain blocking. See
[deployment instructions](DEPLOYMENT.md#reviewed-omission-of-disputed-pay).

These are implementation and sample-validation results, not achieved historical
coverage or catalog-wide disclosure recall. The v7 collection pass reached
4,430/4,670 current source-posting pairs with 240 unresolved at its last audit;
cursor exhaustion is not completion. V9 collection reaches 4,458/4,666 current
source-posting pairs (95.5%) at 19:27 UTC, with 208 pending and zero stale. The
same audit has 944 deferred projections and 26 open conflict records. An earlier
19:22 repair preview remains blocked, with 20 recomputed conflicts; 19 are the
SpaceX source-path issue addressed above and one is the renewed Melius review.
Historical repair remains unapplied pending complete evidence and exact approval.

## Scope and result

The public catalog contained 1,720 roles, including 267 with normalized USD pay
(15.5%). All 1,453 roles without pay were inspected using bounded employer-page
HTTP acquisition and the same exact-posting gate, JSON-LD extraction and metadata
projection used by the application. This is field coverage, not test coverage.

| Initial inspection outcome | Roles |
| --- | ---: |
| Supported pay recoverable by the original extractor | 54 |
| Pay language requiring review | 505 |
| No pay detected in the inspected artifact | 535 |
| Unresolved destination | 275 |
| Aggregate board rather than an exact role | 84 |

Extraction version 2 fixes decimal/comma amounts, annualized pay, hourly/annual
prefix labels, `/per year`, and ordinary connecting words misread as currencies.
Reinspection of the 559 pay-positive/review candidates found 111 with supported
pay, 445 still needing review and three whose destinations became aggregate
boards. That is 57 more recoverable roles than the initial pass. If all 111 pass
the guarded backfill, the unchanged catalog would reach 378/1,720 (22.0%). This
is a recoverability estimate, **not achieved production coverage**.

The audit does not establish recall against all employer disclosures. In
particular, absence from a bounded artifact does not prove absence from the
employer page. Some ranges omit a period or currency, some text concerns benefits
or company revenue, and some destinations need browser inspection. No missing
pay is invented, and no missing-pay role is removed for that reason.

## Acquisition and regression protection

Six minimal live-disclosure fixtures cover Workday, Greenhouse and custom pages.
Lever acquisition preserves structured salary bands, separate salary descriptions,
list sections and all locations. Supported intervals map directly to their stated
period; missing, invalid or unsupported intervals are not assumed annual. The
[public Lever contract](https://github.com/lever/postings-api) documents these
fields; the [Lever reference](https://hire.lever.co/developer/documentation)
defines the salary interval values. Ashby already requests compensation with its
public posting response. Broader provider coverage still needs direct validation.

The first Chrome attempt was interrupted. A subsequent native Chrome pass
inspected 19 unresolved roles: seven disclosed pay, four descriptions had no pay
found, four postings were missing/closed, three remained unresolved, and JPMorgan
disclosed salary amounts without stating a period. Regression clauses cover
Zipline, StepStone, Citadel Securities, Daktronics, Tower Research, Nokia and
Cotiviti. These spot checks do not establish recall for the full unresolved cohort.

Local evidence is archived under `.context/reviews/coverage-audit/` and
`.context/reviews/coverage-audit-v2/` (gitignored): catalog snapshots, per-role
outcomes, bounded pay excerpts, extracted evidence and summaries. Initial audit
completed at 18:22:29 UTC; reinspection completed at 18:27:31 UTC.

## Rollout status

Migrations 0015 and 0016 were applied to production, and PR #161 was deployed
with main's PR #160 recovery and PR #159 trusted-source changes retained. Deployment
preserves the existing unconfirmed-publication setting and 70% identity floor.
The public jobs endpoint returned HTTP 200 after deployment.

Post-deployment at 18:37:32 UTC, the catalog still contained 1,720 roles: 267
retained pay text, 262 had normalized USD values, and 93 had role metadata from
normal processing. Five legacy Skydio/Notion records retained their separate pay
amounts but no longer had one flattened USD minimum/maximum: the existing
normalizer deliberately does not combine multiple distinct candidates. The
22.0% estimate above describes possible pay-text coverage, not one comparable
USD range for every role. Deployed code revision: `1f28d5c`; Worker version:
`e241f4bd-b058-4000-a21a-6c5c3c5f60c6`.

At that deployment, historical collection, guarded dry-run/apply and post-apply
verification remained pending because the operations credential was unavailable.
Do not replace the credential or bypass the exact token/count guards. The
zero-supported-misses objective is not yet established. Next priorities are the
445 pay-language cases and inaccessible/browser-only destinations, followed by
field-by-field validation of education, work mode, locations and dates.

## Expanded implementation and live API pass

PR #161 now includes extraction version 4 and exact-role API acquisition for
Greenhouse, Lever, Ashby, Workday and SmartRecruiters. Greenhouse requests its
[documented transparency fields](https://docs.greenhouse.io/job-board.html#retrieve-a-job);
SmartRecruiters uses its [public posting-detail endpoint](https://developers.smartrecruiters.com/docs/endpoints#postingspostingid).
Workday's public CXS response was checked against both requisition IDs and complete
presentation slugs, including Salesforce's `JR340771-1`; suffixes are not stripped
or merged. Oracle remains on the existing HTML/browser fallback.

The read-only pass completed at **2026-09-06 00:54:53 UTC** (September 5 locally).
It scanned API routes for 1,091 roles from a public snapshot of 1,723 roles.

| API acquisition path | Roles attempted | Exact response acquired | Pay extracted |
| --- | ---: | ---: | ---: |
| Greenhouse | 417 | 409 | 176 |
| Lever | 91 | 90 | 65 |
| Ashby | 149 | 106 | 51 |
| Workday | 388 | 375 | 90 |
| SmartRecruiters | 46 | 46 | 6 |
| Total | 1,091 | 1,026 | 388 |

Of the 388 pay-positive artifacts, 305 correspond to roles without pay in the
original 1,720-role baseline. These are **extraction candidates**, not 305 deployed
fills or an independently reviewed recall measurement. They include native
currencies, explicitly nonstandard intervals, and amounts with an unknown period.
They must pass reconciliation, conflict review and guarded projection repair.

The 65 unsuccessful API acquisitions remain visible: 22 Ashby boards exceeded
the bounded response budget, 18 Ashby responses lacked the requested exact posting,
and 25 requests failed (13 Workday, eight Greenhouse, three Ashby and one Lever).
Browser fallback remains available; none is classified as employer non-disclosure.

The public snapshot had 271 roles with pay (15.7%), 591 with role metadata (34.3%),
137 employer publication dates, 21 deadlines, 25 explicit work modes and 29
graduation windows. The original fixed cohort retains all 1,720 IDs: 267 retained
pay, four gained pay, 1,448 still lack pay and one left the public catalog. These
background-production changes occurred before deploying this expansion.

Reproduce or resume the public audit without operations credentials:

```bash
npm run audit:metadata-coverage -- --baseline PATH_TO_BASELINE_JSON \
  --api-limit 2000 --report .context/metadata-coverage.json
# Revisit failures while retaining completed records:
npm run audit:metadata-coverage -- --api-limit 2000 --retry-failed \
  --report .context/metadata-coverage.json
```

The saved report records per-role methods, versions, hashes, timestamps, failures,
field outcomes and compensation evidence. `--retry` revisits every recorded role;
`--catalog PATH` uses a pinned catalog instead of fetching a new public snapshot.
The local validated report is
`.context/reviews/metadata-api-validated-2026-09-05.json` (gitignored).

Before deployment, apply `0017_metadata_acquisition.sql`. Automated collection
reserves disjoint batches, interleaves hosts, revisits never-inspected/old-version
roles, expires abandoned reservations after 30 minutes and honors API host backoff.
The consumer has concurrency one and batches of five. Manual collection returns
an opaque `nextCursor`; pass it through `--cursor` with the same collection token.
An exhausted cursor is not proof that queued work completed; check the audit and
restart from the beginning after outstanding reservations expire if needed.

`supportedRoleSpecificDisclosedMetadataMisses` and `disclosureRecall` return null
until an independently reviewed benchmark exists. `projectionOnlyOmissions`
remains the separate deterministic projection-diff metric. Per-field outcomes
distinguish extracted, pending inspection, failure, incomplete artifacts,
ambiguity, conflict and projection omission; only independent review can declare
`no-disclosure-found`.

At the read-only API pass, the expansion had **not** been deployed or applied to
historical production records. See the September 6 rollout update below.
Independent review of the remaining browser/pay-language cohort remains open in
[the delivery plan](metadata-coverage-plan.md).

Local validation: 1,274 backend tests and 90 mobile tests passed, alongside root
and mobile type checks, lint, TypeScript build, Worker dry-run build, mobile web
export and OpenTofu formatting/validation. The iOS Simulator build launches;
native pay-detail acceptance remains open because the test deep link showed a
role-unavailable state despite the public detail endpoint returning HTTP 200.
No native screenshot is counted as successful pay-display verification.

## Production rollout — 2026-09-06

The existing operations credential now authenticates successfully; it was not
rotated. Migration `0017_metadata_acquisition.sql` is applied. Worker version
`de22f8fe-5dbf-48cf-823a-35000a3201e0` serves revision `cdda7f6` at 100%
(16:56:51 UTC), with extraction version 7.
The previous dashboard versions had the same script hash as the deployed GitHub
timeout fix `7fc3073`; that fix is merged and retained. Publication remains
enabled with the 70% confirmed-identity floor; trusted-community publication
remains disabled. GitHub full-cycle freshness is still not validated.

Web deployment `39baac25` serves the shared pay formatter at `internnotifs.app`.
An actual browser check confirmed Salesforce's USD 54/hour on both the card and
role detail, with the official-application action available. No native release
or successful native pay-detail acceptance is claimed.

Production canary testing exposed a Worker runtime incompatibility with Fetch
`redirect: 'error'`: API calls failed before reaching employers, despite passing
in Node. Acquisition now uses `manual` and rejects redirects without following
them; a local Worker probe verifies an exact Greenhouse response. Extraction
version 5 revisits the affected browser-only records. Collection and audit now
share eligibility, including open withheld jobs and legacy occurrences whose
confirmed immutable posting key exactly matches their official URL. Neither
change grants new employer authority or alters admission decisions.

The version-5 collection denominator is 4,647 job/source pairs, up from 2,621;
this is not the 1,723-role public catalog denominator. Historical collection is
staging-only. The first production dry run exceeded the 900-record atomic limit;
dry runs now stage at most 900 jobs and report `remainingJobs`, while retaining
global collection, evidence and conflict guards. Every batch needs independent
owner approval of its exact token/counts. No historical repair has been applied.

Public snapshot at 06:25:54 UTC: 1,723 roles, 273 with pay (15.8%), 647 with some
enriched metadata (37.6%), 139 employer publication dates, 21 deadlines, 28
explicit work modes and 29 graduation windows. These include normal ingestion
changes, not historical repair gains or measured disclosure recall.

Version 5's 110 queued pairs produced 41 successful Workday API reports, 21
Greenhouse, five Lever and five SmartRecruiters. Browser reports comprised 32
complete and six incomplete acquisitions. The audit retained 105 current pairs
(one had earlier complete evidence), not 110 successful acquisitions. Aggregate
destinations and truncated/unfinished pages remain unresolved.

Browser inspection of Cohere's exact posting found that its three geographic
salary bands lost their labels when body text was flattened, and `CA$` amounts
were split. Extraction version 6 preserves visible list rows immediately under
explicit compensation headings, recognizes qualified dollar symbols, and keeps
unstated periods unknown. The live DOM supplied a regression that clears the
false conflict through guarded database repair in tests. The same page requires
five years' experience; its eligibility needs separate source-quality review,
not an admission change through metadata backfill.

The version-6 production canary completed all ten pairs. A read-only D1 check
confirmed all three labeled Cohere bands for both source references, including
CAD 140,000–175,000 with unknown period. Its acquisition reports changed from
`conflicting` to `ambiguous` (unstated periods/currencies remain unknown), without
applying a public repair. Collection continues in bounded batches; the 4,647-pair
cohort is not yet complete.

Validation for `13a89ec`: 1,286 backend tests passed, 284 skipped; type checks,
lint, Worker dry-run build and all PR checks passed. Regressions cover the Worker
redirect mode, confirmed legacy identity, version-aware retry backoff, and
901-job repairs with a conflict outside the selected atomic batch. Local rollout
reports are under `.context/reviews/metadata-rollout-2026-09-06/` (gitignored).

### Afternoon validation

Version 7 preserves paragraph/list boundaries in API, JSON-LD and rendered
descriptions; decodes encoded range dashes; and keeps degree/job-level rates
separate. A 53-posting live API corpus reproduced 52 conflicts with the old
parser and zero with the new parser, with pay retained for every posting.
Production evidence confirms J&J's USD 23.50–52.50/hour, Freeform's three
degree-specific hourly rates, and Univera's two labeled ranges with unstated
period/currency. These checks do not establish catalog-wide disclosure recall.

Exact acquisition also supports dotted Ashby board names and observed Greenhouse
embed identities. Live API checks recover Persona's education requirements and
Tower Research's 3,500–5,700/week disclosure (currency not stated). A local browser
confirms Citadel's 4,500–5,800/week disclosure, but production browser acquisition
still fails there. Failed/partial acquisitions retain their retry backoff and
remain unresolved; no guard is relaxed to complete the repair.

At 16:58:37 UTC the public catalog contains 1,682 roles: 270 with pay (16.1%) and
1,007 with enriched metadata (59.9%). The changing public cohort includes normal
ingestion/lifecycle updates, not historical repair gains. Version-7 collection
has restarted across 4,657 eligible job/source pairs and remains incomplete.
The D1 repair-guard table still records zero applied repairs.

Validation for `cdda7f6`: 1,295 backend tests passed, 284 skipped; typecheck, lint,
Worker dry-run build and all PR checks passed. Native acceptance and the
independent disclosure benchmark remain open.
