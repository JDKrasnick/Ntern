# Lever ownership verification plan

## Purpose

Admit Lever employers at more than four at a time without ever guessing which
company owns a site. Greenhouse solved this with an agent working a bounded
candidate ledger against a deterministic probe; Lever needs the same shape, run
backwards, because Lever gives us less to start from.

Admission policy and the shadow-to-published stages live in
[`lever-company-onboarding-plan.md`](lever-company-onboarding-plan.md). This
plan describes how candidates reach that pipeline and how ownership is
established.

## What makes Lever harder than Greenhouse

Greenhouse publishes `GET /v1/boards/{token}`, which returns the board's own
name. An agent can start from a token, take the name as a lead, and search for
the matching company. Lever publishes no equivalent: `GET /v0/postings/{site}`
returns postings and nothing else. A 200 proves a site exists. It attributes
nothing.

| | Greenhouse | Lever |
| --- | --- | --- |
| Identity endpoint | Board name | None |
| Safe starting point | Token, then find the company | Employer, then find the site |
| Cheap wrong guess | Probe returns a name that disproves it | Probe returns jobs that look real |
| Region in identity | No | Yes — global and EU use separate hosts |

The asymmetry matters most in the failure case. A wrong Greenhouse guess
usually announces itself: the board name is some other company. A wrong Lever
guess returns a perfectly healthy board of somebody else's jobs, and nothing in
the response says so. Lever verification must therefore run employer-first, and
a site may never be inferred from a company name.

## Candidate ledger, from evidence we already hold

The reviewed Markdown lists already reference **34 unregistered Lever sites
across 63 eligible listings**, each row carrying a company name a maintainer
wrote next to the link:

| Listings | Site | Company as listed |
| ---: | --- | --- |
| 7 | `cirrus` | Cirrus Logic |
| 4 | `geocomply-2` | GeoComply |
| 4 | `getwingapp` | Wing Assistant |
| 4 | `tomtom` | TomTom |
| 3 | `shyftlabs` | ShyftLabs |
| 3 | `acds` | Arkansas Center for Data Sciences |

That is the initial queue, and it is better than a search-engine sweep: each
candidate arrives with a live job URL, a human-written employer name, and a
count of how many roles it would contribute. `geocomply-2` and `wingtra-2` also
demonstrate why the site string can never be derived from the company name.

Later passes may add harvesters — GitHub code search for `jobs.lever.co/`,
careers-page crawling of the employer roster in `coverage/companies.json`,
web archives — but the ledger above is enough to build and prove the workflow.

The first real run of `npm run lever:ledger` (2026-07-30) found **32 unregistered
sites across 52 eligible listings** out of 1,926 reviewed rows. `cirrus` and
`tomtom` had dropped out entirely and now return 404 — the lists move, which is
why the ledger is regenerated rather than transcribed.

The first agent pass worked the top five and admitted two:

| Site | State | Why |
| --- | --- | --- |
| `acds` | `ownership-verified` | apprenticely.org links the board; Apprenticely is the current name of the Arkansas Center for Data Sciences |
| `shyftlabs` | `ownership-verified` | shyftlabs.io navigation links the board |
| `geocomply-2` | `api-live-unattributed` | 11 postings, 5 eligible; no link on geocomply.com |
| `getwingapp` | `api-live-unattributed` | 505 postings, correct branding; no link on wingassistant.com |
| `reply` | `api-live-unattributed` | 39 postings; no link on reply.com |

Three of five boards were live, healthy, and correctly refused. A pipeline that
admitted on a 200 would have taken all five.

## Stage 1 — Assemble the ledger

`scripts/discover-lever.ts` gains a mode that reads the current catalog and
Markdown snapshots and emits candidates rather than probing sites by name:

```json
{
  "site": "cirrus",
  "observedCompany": "Cirrus Logic",
  "referencingSources": ["speedyapply-2027-swe", "vanshb03-summer-2027"],
  "eligibleListings": 7,
  "sampleJobUrl": "https://jobs.lever.co/cirrus/2f1c.../apply",
  "firstSeenAt": "2026-07-29"
}
```

The ledger is an artifact. It publishes nothing, schedules nothing, and grants
no application-host allowance.

## Stage 2 — Agent-assisted ownership verification

The agent works the ledger in order, never browsing for companies at random.
For each candidate it:

1. runs the deterministic probe (Stage 3) to confirm the site is live and to
   collect posting shapes and hosts;
2. treats `observedCompany` as a lead, never as the catalog display name;
3. searches for the employer's current official site;
4. opens the first-party careers page;
5. looks for a link, embed, script, or application handoff containing
   `jobs.lever.co/{site}` — **this is the ownership evidence, and nothing else
   substitutes for it**;
6. follows one current posting and records the initial and final hosts, plus
   the region the hosts imply;
7. decides whether the site represents the employer, a subsidiary, a staffing
   agency, a regional entity, or a shared board;
8. captures the minimum evidence needed for another person to reproduce the
   conclusion.

Search sequence, repeatable and bounded:

```text
site:{candidate domain} lever.co
site:{candidate domain} (careers OR jobs)
"{observedCompany}" careers lever
"jobs.lever.co/{site}"
```

The agent emits one state per candidate:

- `ownership-verified` — the employer's own domain links to this exact site;
- `api-live-unattributed` — the site serves postings, first-party evidence is
  missing. **Never admissible.** Greenhouse can sit here on the strength of a
  board name; Lever cannot, because nothing attributes the site;
- `ambiguous-owner` — several plausible employers, a shared or agency board;
- `subsidiary-or-regional` — ownership is clear but the entity differs from the
  listed company, or the region is EU;
- `custom-host-review` — application URLs leave `jobs.lever.co`;
- `stale-or-reassigned` — evidence conflicts with the current site contents;
- `inconclusive` — blocked, unavailable, or non-reproducible.

Only `ownership-verified` proceeds. Everything else goes to a human exception
queue with its evidence attached.

Evidence record, which is also the shape `ReviewedLeverSource` already stores:

```json
{
  "site": "cirrus",
  "displayName": "Cirrus Logic",
  "careersUrl": "https://www.cirrus.com/careers/",
  "firstPartyEvidenceUrl": "https://www.cirrus.com/careers/",
  "evidenceExcerpt": "<a href=\"https://jobs.lever.co/cirrus\">View openings</a>",
  "observedJobUrl": "https://jobs.lever.co/cirrus/2f1c.../apply",
  "initialHosts": ["jobs.lever.co"],
  "region": "global",
  "state": "ownership-verified",
  "verifiedAt": "2026-07-29T00:00:00Z"
}
```

`evidenceExcerpt` is the difference between an audit trail and a claim. It
records the actual markup that proved the link, so a reviewer confirms the
conclusion without repeating the search.

## Stage 3 — Deterministic probe

A probe command, mirroring `probeGreenhouseCandidate`, that is read-only and
returns only safe counts:

- resolves `https://api.lever.co/v0/postings/{site}?mode=json` with the
  paginated reader, so a large board is measured whole;
- validates every posting against the existing URL contract — `hostedUrl` and
  `applyUrl` must be `https://jobs.lever.co/{site}/{id}[/apply]`;
- summarises raw postings, eligible early-career roles, distinct application
  hosts, malformed rows, and a few role titles;
- classifies transport, HTTP, schema, and identity failures with the existing
  categories;
- writes an artifact. It never writes the registry.

The probe is what makes agent output checkable: the agent's prose claim is
discarded, its evidence URLs are kept, and the numbers come from the probe.

## Stage 4 — Shadow, then publish

`ReviewedLeverSource` already carries `careersUrl`, `admittedAt`, `status`, and
`region`. The dedicated Lever FIFO runner schedules every reviewed board:
published boards write through the normal poller, while shadow boards use
isolated `shadow-{sourceId}` checkpoints and never write jobs or notifications.
Published boards run every thirty minutes whether active or quiet. Shadow
boards are deterministically staggered across three-hour checks.

Shadow evaluation should observe, for at least one week:

- snapshot completeness and hash stability across polls;
- eligible-role counts and their variance;
- application-link verification rates for the board;
- zero identity or URL-contract failures.

Promotion stays one field. The first published snapshot is quiet regardless, so
promotion cannot produce an alert storm.

## Stage 5 — Re-verification

Ownership decays: employers leave Lever, get acquired, or rename. `admittedAt`
is the key a re-verification pass reads.

- re-run the probe for every published board on the existing nightly cadence;
- re-run agent verification for any board whose `admittedAt` is older than 180
  days, or whose probe shows an identity or host change;
- a board that fails re-verification returns to shadow rather than being
  deleted, so the catalog keeps its roles while a human looks.

## Trust boundaries

- A live API response is never ownership evidence.
- A company name is never a safe API input; the site string comes from an
  observed URL only.
- Aggregator pages, job boards, and Lever's own domain cannot supply first-party
  evidence.
- Discovery artifacts cannot publish. Only a reviewed registry entry can.
- Region is recorded, never inferred at runtime.
- The agent proposes; the probe measures; a person approves anything ambiguous.

## Delivery sequence

1. **Ledger** — `npm run lever:ledger` (`src/sources/lever-ledger.ts`,
   `scripts/lever-ledger.ts`). Reads the reviewed Markdown sources and emits
   `artifacts/lever-candidate-ledger.json`. Sites come out of observed
   `jobs.lever.co` URLs only. **Built.**
2. **Probe** — `npm run lever:probe -- <site>` (`src/sources/lever-probe.ts`).
   Read-only, paginated, counts only, `attribution: 'unattributed'`. **Built.**
3. **Agent pass** — `.claude/agents/lever-ownership-verifier.md` works one
   candidate and writes `test/fixtures/lever/{site}/{evidence,probe}.json`.
   `npm run lever:manifest` (`src/sources/lever-manifest.ts`) is the
   deterministic arbiter: it validates the probe envelope and site, requires a
   clean unattributed probe before admission, binds `admittedAt` to the
   evidence's `verifiedAt`, and cross-checks the registry and quality policy.
   `test/lever-ownership.test.ts` covers the gate. **Built.**
4. **Shadow runner** — the ingestion Worker's Lever Cron dispatch and
   provider-specific Cloudflare Queue schedule all reviewed boards with
   per-board ordering, bounded retries and concurrency, isolated shadow
   checkpoints, quiet published baselines, and operations telemetry.
   **Built.**
5. **Re-verification** — the 180-day `admittedAt` clock is enforced by the
   manifest gate, and `npm run lever:reverify` refetches each verified board's
   recorded evidence page. It reports `exact`, `link-only`, or `missing`:
   `missing` means the employer stopped linking the board and the evidence is
   gone; `link-only` means the recorded markup no longer matches the page, which
   is usually an agent that paraphrased its own excerpt. **Built.** The nightly
   cadence and the automatic demotion to shadow are **not built**; today the
   command exits non-zero and a person acts.

Steps 1–4 admit and observe the backlog safely at volume. Step 5 keeps ownership
evidence current.

### Commands

| Command | Stage | Writes |
| --- | --- | --- |
| `npm run lever:ledger` | 1 | `artifacts/lever-candidate-ledger.json` |
| `npm run lever:probe -- <site>` | 2 | stdout, optionally `--out <path>` |
| `npm run lever:manifest` | 3, 5 | nothing; exits non-zero on violations |
| `npm run lever:reverify` | 5 | nothing; network, exits non-zero on `missing` |
| `npm run test:lever:live` | 5 | nothing; opt-in, network |

None of them writes `src/sources/lever-config.ts`. Admission is a reviewed edit.
