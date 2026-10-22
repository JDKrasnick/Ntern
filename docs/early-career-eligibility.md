# Explicit employer evidence for early-career roles

The runtime gate is `EARLY_CAREER_ELIGIBILITY_ENABLED=true`, absent by default.
Legacy polling and V2 admission share the policy. Policy version 4 and metadata
extraction version 24 enroll existing rows in bounded re-evaluation when enabled.
Opening or merging this implementation does not activate production or backfill.

## Publication rule

Require the exact employer posting to identify an internship, co-op,
apprenticeship, working-student placement, new-grad programme or entry-level
opportunity. Accept an official title, structured employment type, or a
role-directed statement in the description. A direct invitation to fresh
or recent graduates also qualifies; a generic experienced-applicant template
elsewhere does not erase that explicit invitation.

| Employer evidence | Catalog and alerts | Classification |
| --- | --- | --- |
| Explicit programme or entry-level applicant eligibility | Eligible subject to all other gates | Employer-supported type |
| Verified generic technical job without programme evidence | Withheld | Unknown |
| Mentoring interns, prior internship experience, excluding internships, or general company programme advertising | No positive programme evidence | Unknown |
| Recruiter/programme-administrator title describing student hiring | Withheld | No invented internship |
| Explicit denial or incompatible internship/professional-experience claims | Withheld pending resolution | Unknown |
| Missing exact employer evidence | Withheld pending acquisition | Unknown |

Full-time employment alone does not exclude an internship. Academic duration
and advanced research requirements do not disqualify an explicit student
placement. `Cooperative AI` does not mean co-op. No numeric seniority score or
salary threshold turns a generic role into an early-career opportunity.

An exact artifact records the official title, source URL, content hash,
observation time, policy version, reason and bounded supporting excerpts.
Community classifications cannot override current official evidence. Newer
employer evidence supersedes older claims; simultaneous substantive conflicts
remain withheld. An empty page shell does not negate a matching informative API
artifact. Other identity, destination, employer, technical-scope and source-trust
requirements still apply.

Metadata refresh synchronizes canonical and per-reference admissions, programme
classification and official titles. Removing eligibility clears pending
SMS/digest flags while preserving lifecycle and saved application history. V2
exclusions use the existing fenced revocation effect. Provider index candidates
may reach bounded hydration; final admission still requires explicit evidence.

## Acquisition repairs

Lever acquisition uses the EU API for exact EU postings and preserves observed
tenant case. Validation remains bound to canonical employer, immutable posting
ID and region. An exact Lever API 404 may recover identity-matched JobPosting
JSON-LD from the employer page; a 410 never takes this fallback. Existing
lifecycle and destination closure decisions remain authoritative.

JSON-LD and provider metadata preserve structured employment type. For example,
AltaML's generically titled Associate Software Engineer is an `Intern` placement
for current students. These repairs recovered seven genuine internships from
the first batch rather than relying on community labels.

## Retrospective evaluation on 400 postings

Two disjoint 200-posting cohorts contain live-acquired employer evidence from
October 21, 2026. Sources, initial labels and follow-up review are separately
frozen and hash-checked. General/unspecified jobs previously allowed for coverage
are intentionally excluded by the new scope overlay; original labels are never
rewritten. Source review used the same reviewer throughout, without independent
human adjudication. This is a diagnostic retrospective replay, not a new blind
holdout or population accuracy estimate.

| Publication outcome | Original 200 | Additional 200 | Total |
| --- | ---: | ---: | ---: |
| True positive | 94 | 108 | 202 |
| True negative | 100 | 87 | 187 |
| False positive | 0 | 0 | 0 |
| False negative / known coverage gap | 1 | 1 | 2 |
| Unverifiable, withheld | 5 | 4 | 9 |

The implementation reproduces the experiment. The owner accepted these two
coverage boundaries when requesting implementation:

- [Replit Cohort 0](https://jobs.ashbyhq.com/replit/2c147ccb-2557-40f8-aab9-64422cef220c/application)
  matches internship evidence, but the existing technical classifier shelves
  its generic title and mixed-team description. The normalized replay does not
  carry every original source classification tag, so this is not a verified
  live production exclusion.
- [Anthropic Fellows Program](https://job-boards.greenhouse.io/anthropic/jobs/5183044008)
  is a funded, mentored four-month research opportunity. Fellowship language
  alone is outside the explicit programme types. Preserve it as a known miss;
  do not relabel it negative to report zero errors.

The programme matcher alone finds every verified internship/co-op in the
cohorts: 204 true positives, 186 true negatives, zero false positives and one
miss (the fellowship), plus nine unverifiable cases. That denominator includes
a genuine nontechnical internship; publication correctly shelves it separately.
Plain intern/co-op matching anywhere produces three false positives and 17
false negatives on the same programme labels.

`scripts/evaluate-early-career-policy.ts` verifies supplied corpus/label freezes,
optionally overlays the frozen follow-up review, and composes the real source
processor, technical check, metadata extractor and admission policy. Identity
and destination gates are held valid; this does not exercise live queues, durable
writes or every original provider adapter. It writes JSON and CSV and exits
nonzero for observed false admissions/exclusions, including these known misses.
The original audit artifacts remain workspace-local and are not bundled in Git.

```sh
npx tsx scripts/evaluate-early-career-policy.ts \
  --corpus .context/early-career-200/corpus.json \
  --labels .context/early-career-200/labels.json \
  --review .context/early-career-coverage/review.json \
  --output .context/implemented-original.json

npx tsx scripts/evaluate-early-career-policy.ts \
  --corpus .context/early-career-fresh-200/corpus.json \
  --labels .context/early-career-fresh-200/labels.json \
  --output .context/implemented-fresh.json
```

## Before production activation

- Validate enabled polling, refresh, catalog visibility, notifications and
  replay against durable storage in isolated dev.
- Preview a bounded backfill/canary and retain acquisition failures separately.
- Use the guarded release workflow. Disabling the flag alone does not reverse
  persisted admission decisions; rollback requires an explicit data plan.

## Reviewed production backfill

`POST /internal/early-career/backfill` requires the operations key. `preview`
accepts at most ten open job IDs and bounded, employer artifacts observed within 24 hours
or confirmed exact-page absence receipts. Each proof is bound to an existing
source occurrence and its reviewed exact employer/API target. Unsupported/blocked
pages are held for review; an API error alone never proves a posting is absent.
Pruning requires refreshed proof within 30 minutes. Before pruning a merged job, every distinct open target must be reviewed. One
qualifying live target protects a job with another expired alias.

The preview returns every proposed visibility change and an exact token/count.
`apply` expires after ten minutes and atomically guards all canonical and source
occurrence values against concurrent changes. It persists current proof, updates
browse indexes and pending-alert flags, and preserves lifecycle, application and
sent-notification history. Backfill never creates notification events. Changed
visibility/presentation requires projection refresh before the API returns.

The live preview found additional valid explicit placements absent from the
English-heavy 400-case audit: French/Italian stages, Spanish prácticas, German
Pflichtpraktikum, UK industrial/student placements and student-worker contracts.
These are explicit employer programmes, not unspecified roles. Categorical
negation is type-specific: “not an internship” does not deny a working-student
contract, and “not an internship built around shadowing” is not a denial.
Production activation is managed by OpenTofu and remains false until reviewed
backfill receipts and isolated-dev verification are complete.

Activation preserves previously visible, unreviewed legacy roles when programme
proof is missing, and records `earlyCareerReviewPending` while suppressing alerts.
This hold never admits a new or previously withheld role and never bypasses
identity, destination or technical gates. Positive proof can enroll a legacy role
automatically; withdrawals require the reviewed backfill. Once enrolled, later
source refreshes continue enforcing the policy even with the global flag off.
Unsupported employer pages therefore stay visible pending inspection rather than
being removed speculatively. New roles always require explicit employer evidence.
