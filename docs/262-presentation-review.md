# Issue #262 employer-presentation review

Reviewed 2026-09-24 against the employer-owned posting page for each exact
provider identity (`provider:tenant:posting ID`). Baseline audit:
`.context/262-post-occurrence-audit.json` on `origin/main` (`05f9ef7`), which
reported 18 matched posting groups whose records disagree about the employer.

Each page below was fetched once, with a browser user agent, at the URL in the
row. `reviewed presentation` means the page established the employer name as
shown, the exact title, the exact location, and the canonical application URL;
the decision is recorded in
`cloudflare/migrations/0034_posting_presentation_review_records.sql`.

- `evidence_hash` is the SHA-256 the runtime validates for the reviewed record
  (the canonical JSON of the recorded fields).
- `page hash` is the SHA-256 of the raw HTML served at the evidence URL; it
  identifies the exact page state that was reviewed.

| Provider identity | Outcome | Evidence page | Employer | Title | Location | `evidence_hash` | page hash |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `amazon:amazon:10517567` | reviewed presentation | [page](https://www.amazon.jobs/en/jobs/10517567) | Amazon | Software Development Engineer Intern, Annapurna Labs - 2027 | USA, TX, Austin | `091ee990dbf92cb9a22e3f2a9f574280e6d3e05401dc84535cfb1e5ba0b9dd80` | `13390bd28ca380fa0bc486e05d323248e4693429a0d2759226e79735bc929790` |
| `smartrecruiters:boschgroup:744000142898574` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000142898574) | Bosch Group | Powertrain Controls Software Engineering Intern (6-Months, Full-Time) | Hills Tech Dr, Farmington Hills, MI 48331, USA | `85b5777bedbf0dbfa460ebe0f667fba898dee9581a55820a27763f9629cd27c1` | `46ab61d243730d151446932015029215e93c5eb5a32b26172554d06e0d502f95` |
| `smartrecruiters:boschgroup:744000145507908` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000145507908) | Bosch Group | AI Security Research Intern | 2555 Smallman St, Pittsburgh, PA 15222, USA | `0785bc4c4773902af6eb91eba17baadc5b049d427a32ba90fc3583ec40f391f3` | `7bc6aa7063d50c5cc9c1aa5ed7366c6b67ff8cfa1464d3c8015dd28d833659ea` |
| `smartrecruiters:boschgroup:744000145785190` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000145785190) | Bosch Group | Phone as a Key Software Engineering - Intern | 15000 N Haggerty Rd, Plymouth, MI 48170, USA | `6fafd6d64294f1a04775f5e8ca8d71c18706b139e5b368b7ee39e6d707cdcb64` | `76d9844f81ca98b0b724bb3437b2a03bd2e2dd12088d35ab884c2122183836a4` |
| `smartrecruiters:boschgroup:744000146546699` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000146546699) | Bosch Group | Calibration Process Data Science Intern (8 months/40 hours per week) | 38000 Hills Tech Dr, Farmington Hills, MI 48331, USA | `e6d074a5c34fc6466d7f8cc4c7e2ec1a2f92d61e1c723b78e5c7a33227704c8e` | `6f25c0349849853531d9fb2a605613a5e8d4f81acccc2b7f88da2f195a26c2c8` |
| `smartrecruiters:boschgroup:744000146546849` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000146546849) | Bosch Group | Software Engineering Intern (8 months/40hrs per week) | 38000 Hills Tech Dr, Farmington Hills, MI 48331, USA | `8454d78acd8d2cf962ec571883d1dd9fecf7b275b38016cc68bda5f3b0f604dc` | `509e5d4088ba2274990d198e527132eca5ced1636d6dcf1ab142dafc8d566ef8` |
| `smartrecruiters:boschgroup:744000146547599` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000146547599) | Bosch Group | AI Application Intern (8 months/40 hours per week) | 38000 Hills Tech Dr, Farmington Hills, MI 48331, USA | `cbcffca80d13f75fd8a0b094caa2652cb3fff2a8311b758a11163f92f8b45a94` | `df393da45184a053c34bd6e542478b49b6af6811af40a738c2d1924375afb157` |
| `smartrecruiters:boschgroup:744000148575999` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000148575999) | Bosch Group | Product Management AI-Tool Intern (8 months/40hrs per week) | 38000 Hills Tech Dr, Farmington Hills, MI 48331, USA | `bb3f004baa8a9bb9328cdc2bf7992393839c0f43767b71a1999ad68e3c4ff23c` | `4682308cd770217aa9db0c5aa02ed2b124829929c4c79fd1ae4bb4a928805ebc` |
| `smartrecruiters:boschgroup:744000148595878` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000148595878) | Bosch Group | Data Analytics Intern - Engineering & SAP Operations | 500 Barclay Blvd, Lincolnshire, IL 60069, USA | `79afebb5d3ce6c36250c1fea694ee6e1f5722bb59468554842d838fdf2f4e66c` | `b2a81337190ffa4e1ed9e9d65478f1302c18d876e6fe1ecada64de8bcf97abbd` |
| `smartrecruiters:boschgroup:744000150217869` | reviewed presentation | [page](https://jobs.smartrecruiters.com/BoschGroup/744000150217869) | Bosch Group | AI Engineering Intern (October 2026 - August 2027) | 15000 N Haggerty Rd, Plymouth, MI 48170, USA | `6245c95c56b5d5af34859e394880e2b8b2059db92448174025ea3d3ebb8671ec` | `008ce4eebf8464894920807cbab9e229d5e20057214cb1068925d080a8a88f51` |
| `smartrecruiters:gdmsi:744000146822449` | insufficient evidence | [page](https://jobs.smartrecruiters.com/GDMSI/744000146822449) | — | — | — | `8f8f3f0db5d871db5767f8cc74f698be617930ba063b80438d7c87721981c7e1` |
| `smartrecruiters:gdmsi:744000146985399` | insufficient evidence | [page](https://jobs.smartrecruiters.com/GDMSI/744000146985399) | — | — | — | `a4debfe336ff6ca3465724d3d60f980ff7274199686282b0428ab5e88d36c171` |
| `smartrecruiters:gdmsi:744000147019949` | insufficient evidence | [page](https://jobs.smartrecruiters.com/GDMSI/744000147019949) | — | — | — | `2b9a00c9ab729fc27b5d32b6fdf847b31f658c7ec380239639d89be2c37e9316` |
| `smartrecruiters:gdmsi:744000147563929` | insufficient evidence | [page](https://jobs.smartrecruiters.com/GDMSI/744000147563929) | — | — | — | `8d5865e8a72319539b775a408f5559b68e9a0c6d0a7f110db3eaf38ede84cbc7` |
| `smartrecruiters:gdmsi:744000147583700` | insufficient evidence | [page](https://jobs.smartrecruiters.com/GDMSI/744000147583700) | — | — | — | `ac0c97817c2d971cf1557b0d2aaef15b4a19407e1af4060ec3e6cbea21b10761` |
| `icims:jobs-cesi:11204` | insufficient evidence | [page](https://jobs-cesi.icims.com/jobs/11204/software-design-engineer-intern/job) | — | — | — | `2c5723d24931e4d17316b6a535d54d2820ca0dc3e1cfb8c2252e1538c309f630` |
| `icims:jobs-cesi:11206` | insufficient evidence | [page](https://jobs-cesi.icims.com/jobs/11206/ai-intern/job) | — | — | — | `67c933019a77799566e7e986c14eca1395b8de1dfd87fed61c981cd0988be817` |
| `icims:gsk-us-earlytalent:11013` | insufficient evidence | [page](https://gsk-us-earlytalent.icims.com/jobs/11013/winter-co-op-web-app-developer/job) | — | — | — | `39ca35f7841da7bc0b09785ce55d9c863787714fa26330cd265647c10c6fbaeb` |

## Review notes

- `amazon:amazon:10517567`: the page's employer line reads
  `Job ID: 10517567 | Annapurna Labs (U.S.) Inc. - D63`, while the posting brand
  is Amazon. The reviewed presentation uses the brand shown as the employer,
  `Amazon`; Annapurna Labs is an Amazon subsidiary and the title still names it.
- The Bosch pages name different legal entities per posting (`Robert Bosch LLC`
  for most, `Bosch Rexroth Corporation` for `744000148595878`) while presenting
  `Bosch Group` as the employer on the page, logo, and site name. The reviewed
  company is the presentation, `Bosch Group`, not the per-posting legal entity.
- `smartrecruiters:boschgroup:744000150217869` is closed ("This job has
  expired"), but the page still serves the summary that establishes the employer,
  title, and location, and the posting URL still parses to the exact identity.
- The employer pages were read on 2026-09-24; the recorded hashes pin that state,
  and the row's own `evidence_hash` is what the runtime revalidates on every
  audit.

## Groups left unresolved

`insufficient evidence` for every row on the following grounds; no ledger record
was written and the group stays blocked.

- `icims:jobs-cesi:11204`, `icims:jobs-cesi:11206`: the icims posting page
  returns `410 Gone` and the tenant now serves the Cole Engineering Services
  careers home page. The exact posting is withdrawn, so the page cannot
  establish title, location, or application URL.
- `icims:gsk-us-earlytalent:11013`: the icims posting page redirects to
  `atriumstaff.jibeapply.com`, which serves only the "Ahead Together: GSK
  Internships and Co-ops" programme shell. The posting page no longer exists
  under the reviewed identity.
- `smartrecruiters:gdmsi:744000146822449`, `...:744000146985399`,
  `...:744000147019949`, `...:744000147563929`, `...:744000147583700`: each URL
  returns `200` but serves a republished posting whose canonical URL carries a
  different posting ID, listed below. The reviewed identity no longer names a
  distinct live posting, and a ledger row whose URL parses to a different
  posting ID is rejected at runtime.

| Reviewed posting ID | Current posting ID served | Title |
| --- | --- | --- |
| `744000146822449` | `744000147561809` | Co-op Winter 2027 - Software Engineering - 8 Months |
| `744000146985399` | `744000147556214` | Co-op Winter 2027 - Software Engineering Developer - 16-Months |
| `744000147019949` | `744000147554134` | Co-op Winter 2027 - Software Developer - 8 Months |
| `744000147563929` | `744000149415235` | Co-op Winter 2027 - Software Engineering (TacCIS Solutions) -12 Months |
| `744000147583700` | `744000151059868` | Co-op Winter 2027 - Software Engineering - 4-8 months |

Re-anchoring those five catalog URLs to the current posting IDs, and retiring
the two removed Cole Engineering postings, is a separately reviewed source
change; it is not part of this migration.

## Effect on the gate

Grouped by employer presentation, only `employerIdentity` blocked these groups,
and the reviewed row is authoritative for its exact provider identity. Replaying
the 43 production job records named in the review handoff through the planner
(`scope: identity`, all migrations applied) returns:

- `duplicateGroups: 18`
- `eligibleDuplicateGroups: 10` — the ten reviewed identities above
- `unresolvedDuplicateGroups: 8` — the groups left unresolved above
- `expectedChanges: 46`, `conflicts: []`

The remaining eight groups keep the integrity gate red until the re-anchoring
source change lands.
