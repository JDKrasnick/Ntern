# Issue #262 employer-presentation review and source correction

Reviewed 2026-09-24 against the employer-owned posting page for each exact
provider identity (`provider:tenant:posting ID`). Baseline audit:
`.context/262-post-occurrence-audit.json` on `origin/main` (`05f9ef7`), which
reported 18 matched posting groups whose records disagree about the employer.

Each page was fetched once, with a browser user agent, at the URL in the row.
`page hash` is the SHA-256 of the raw HTML served there and identifies the exact
page state that was reviewed. Every ledger row also carries the
runtime-validated `evidence_hash` over its recorded fields; those values are in
`cloudflare/migrations/0034_posting_presentation_review_records.sql`,
`cloudflare/migrations/0035_posting_source_corrections.sql`, and
`cloudflare/migrations/0036_posting_withdrawal_reviews.sql`.

| Provider identity | Outcome | Evidence page | Recorded employer | Recorded title | Recorded location | page hash |
| --- | --- | --- | --- | --- | --- | --- |
| `amazon:amazon:10517567` | reviewed presentation | [page](https://www.amazon.jobs/en/jobs/10517567) | Amazon | Software Development Engineer Intern, Annapurna Labs - 2027 | USA, TX, Austin | `13390bd28ca380fa0bc486e05d323248e4693429a0d2759226e79735bc929790` |
| `smartrecruiters:boschgroup:744000142898574` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000142898574) | Bosch Group | Powertrain Controls Software Engineering Intern (6-Months, Full-Time) | Hills Tech Dr, Farmington Hills, MI 48331, USA | `46ab61d243730d151446932015029215e93c5eb5a32b26172554d06e0d502f95` |
| `smartrecruiters:boschgroup:744000145507908` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000145507908) | Bosch Group | AI Security Research Intern | 2555 Smallman St, Pittsburgh, PA 15222, USA | `7bc6aa7063d50c5cc9c1aa5ed7366c6b67ff8cfa1464d3c8015dd28d833659ea` |
| `smartrecruiters:boschgroup:744000145785190` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000145785190) | Bosch Group | Phone as a Key Software Engineering - Intern | 15000 N Haggerty Rd, Plymouth, MI 48170, USA | `76d9844f81ca98b0b724bb3437b2a03bd2e2dd12088d35ab884c2122183836a4` |
| `smartrecruiters:boschgroup:744000146546699` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000146546699) | Bosch Group | Calibration Process Data Science Intern (8 months/40 hours per week) | 38000 Hills Tech Dr, Farmington Hills, MI 48331, USA | `6f25c0349849853531d9fb2a605613a5e8d4f81acccc2b7f88da2f195a26c2c8` |
| `smartrecruiters:boschgroup:744000146546849` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000146546849) | Bosch Group | Software Engineering Intern (8 months/40hrs per week) | 38000 Hills Tech Dr, Farmington Hills, MI 48331, USA | `509e5d4088ba2274990d198e527132eca5ced1636d6dcf1ab142dafc8d566ef8` |
| `smartrecruiters:boschgroup:744000146547599` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000146547599) | Bosch Group | AI Application Intern (8 months/40 hours per week) | 38000 Hills Tech Dr, Farmington Hills, MI 48331, USA | `df393da45184a053c34bd6e542478b49b6af6811af40a738c2d1924375afb157` |
| `smartrecruiters:boschgroup:744000148575999` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000148575999) | Bosch Group | Product Management AI-Tool Intern (8 months/40hrs per week) | 38000 Hills Tech Dr, Farmington Hills, MI 48331, USA | `4682308cd770217aa9db0c5aa02ed2b124829929c4c79fd1ae4bb4a928805ebc` |
| `smartrecruiters:boschgroup:744000148595878` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000148595878) | Bosch Group | Data Analytics Intern - Engineering & SAP Operations | 500 Barclay Blvd, Lincolnshire, IL 60069, USA | `b2a81337190ffa4e1ed9e9d65478f1302c18d876e6fe1ecada64de8bcf97abbd` |
| `smartrecruiters:boschgroup:744000150217869` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000150217869) | Bosch Group | AI Engineering Intern (October 2026 - August 2027) | 15000 N Haggerty Rd, Plymouth, MI 48170, USA | `008ce4eebf8464894920807cbab9e229d5e20057214cb1068925d080a8a88f51` |
| `icims:gsk-us-earlytalent:11013` | reviewed presentation | [page](https://gsk-us-earlytalent.icims.com/jobs/11013/winter-co-op-web-app-developer/job?mobile=true&needsRedirect=false) | GSK | Winter Co-op/Web App Developer | US-Cambridge MA/Hybrid | `7a643fae1b24798f2f87f6c1895fe52ea661d827335c366eb74f4101e6452552` |
| `smartrecruiters:gdmsi:744000147561809` | reviewed presentation | [page](https://jobs.smartrecruiters.com/GDMSI/744000147561809) | General Dynamics Mission Systems | Co-op Winter 2027 - Software Engineering - 8 Months | 1941 Robertson Road, Ottawa, Ontario, Canada | `5d8fe63c10c3cd56141295cf97b6c06f52bb2ef4bd3ee442ed61bc2f86ff72c3` |
| `smartrecruiters:gdmsi:744000147556214` | reviewed presentation | [page](https://jobs.smartrecruiters.com/GDMSI/744000147556214) | General Dynamics Mission Systems | Co-op Winter 2027 - Software Engineering Developer - 16-Months | 1120 68 St SE #110, Calgary, AB T2A 7B2, Canada | `1ad4b16b9a33774909826f60cbd41916b472a9706859c29dcf9e6731adad961b` |
| `smartrecruiters:gdmsi:744000147554134` | reviewed presentation | [page](https://jobs.smartrecruiters.com/GDMSI/744000147554134) | General Dynamics Mission Systems | Co-op Winter 2027 - Software Developer - 8 Months | 1941 Robertson Road, Ottawa, Ontario, Canada | `02bfb3dc40a84d4b7e66c157e2cad4ecd21aad5de20052d6c8597605485ec993` |
| `smartrecruiters:gdmsi:744000149415235` | reviewed presentation | [page](https://jobs.smartrecruiters.com/GDMSI/744000149415235) | General Dynamics Mission Systems | Co-op Winter 2027 - Software Engineering (TacCis Solutions) -12 Months | 1120 68 Ave NE #110, Calgary, AB T2E 8S5, Canada | `d6558a73420e9e5ba8b33bd948d5936eed599ddf35710c08b51ab1e5c5a6e43d` |
| `smartrecruiters:gdmsi:744000151059868` | reviewed presentation | [page](https://jobs.smartrecruiters.com/GDMSI/744000151059868) | General Dynamics Mission Systems | Co-op Winter 2027 - Software Engineering - 4-8 months | 31 Millbrook Avenue, Cole Harbour, Nova Scotia, Canada | `85c6a782bb0cedb319a228367479367bda85e50bca7e750346845f1c5f2a8fe5` |
| `icims:jobs-cesi:11204` | withdrawn | [page](https://jobs-cesi.icims.com/jobs/11204/job?mobile=true&needsRedirect=false&utm_source=Simplify&ref=Simplify) | — | — | — | `4d67d79c318f44b55d40801bcac1b9362dac18619b8dc37cca6fc25a84dac364` |
| `icims:jobs-cesi:11206` | withdrawn | [page](https://jobs-cesi.icims.com/jobs/11206/job?mobile=true&needsRedirect=false&utm_source=Simplify&ref=Simplify) | — | — | — | `4d67d79c318f44b55d40801bcac1b9362dac18619b8dc37cca6fc25a84dac364` |

Only `employerIdentity` blocked these groups, and a reviewed row is
authoritative for its exact provider identity, so the recorded employer settles
the member-level disagreement.

## Re-anchored postings

Five General Dynamics SmartRecruiters ids that the community lists still publish
were republished by the employer. Each stale URL returns `200` and the
employer's own page declares the current immutable posting id as its canonical
URL, which is the evidence recorded in `posting_url_corrections`.


| Stale posting identity (as published) | Current posting identity | Evidence page | page hash |
| --- | --- | --- | --- |
| `smartrecruiters:gdmsi:744000146822449` | `744000147561809` | [old URL](https://jobs.smartrecruiters.com/GDMSI/744000146822449) | `5d55cddf33bf285141f82644322751469097113cff118fcb3acfbf943af896fd` |
| `smartrecruiters:gdmsi:744000146985399` | `744000147556214` | [old URL](https://jobs.smartrecruiters.com/GDMSI/744000146985399) | `7787c107fbfddec286dafd5063da39fe9ae0dd47aec1295745c65dc31dea6445` |
| `smartrecruiters:gdmsi:744000147019949` | `744000147554134` | [old URL](https://jobs.smartrecruiters.com/GDMSI/744000147019949) | `dfbc5f91570ca38c6e657dbcf0cf82feeca335369c40646ca75c262cb1184af6` |
| `smartrecruiters:gdmsi:744000147563929` | `744000149415235` | [old URL](https://jobs.smartrecruiters.com/GDMSI/744000147563929) | `6315fb3df516cb9e278edde0e674963e0f5220d29409cf1e1dc18e4b91b104b2` |
| `smartrecruiters:gdmsi:744000147583700` | `744000151059868` | [old URL](https://jobs.smartrecruiters.com/GDMSI/744000147583700) | `043015561241581ab7700f3ee291508503238fad903293e3bc7f0b280122ca8d` |


Re-anchoring changes identity resolution only. The source row's own URL stays as
provenance; the catalog converges on the employer's current posting, so the
stale list row cannot re-create a twin.

## Withdrawn postings

Both Cole Engineering Services postings now return **`410 Gone`**. The tenant
serves By Light HQ's job board, and the page carries the employer's own message:
*"The job that you were looking for either does not exist or is no longer
open."* No corrected URL exists, so `posting_withdrawal_reviews` retires the
identity instead of merging it: it contributes no repair evidence, and the
ingestion reconciler keeps the record closed while the lists still publish it.

## Earlier review pass

The pass recorded in `0034` covered the ten identities above through the Bosch
and Amazon rows. Two conclusions from it were corrected here and are worth
recording:

- `icims:gsk-us-earlytalent:11013` was first reported as insufficient evidence
  because the slug-form URL without query parameters
  (`/jobs/11013/winter-co-op-web-app-developer/job`) serves only the programme
  shell. Both URLs that carry `?mobile=true&needsRedirect=false` — the one the
  community lists use and the one recorded in the ledger — serve the full
  posting, byte-identical (54 607 bytes, "Winter Co-op/Web App Developer",
  hiring organization "GSK Internships & Co-ops powered by Atrium"), so the
  identity is reviewable and is now recorded. The ledger records the page's own
  canonical (`og:url`) form.
- The five General Dynamics identities were recorded as "republished under a
  different posting id, no decision". They are now re-anchored and reviewed.

## Effect on the gate

Replaying the 43 production job records named in the review handoff through the
planner (`scope: identity`, every migration applied) returns:

- `duplicateGroups: 16`, `eligibleDuplicateGroups: 16`
- `unresolvedDuplicateGroups: 0`, `presentationDisagreements: []`
- `expectedChanges: 78`, `conflicts: []`

The withdrawn postings contribute no group, and the re-anchored members join the
live posting's group, which the recorded employer presentation resolves. Applying
that plan and re-running the read-only audit is the remaining step before #262
closes.
