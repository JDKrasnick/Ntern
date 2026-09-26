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

1. **Admission records the task.** When posting admission resolves a canonical employer, `src/poll.ts` hands the employer ID, the application URL, and the provider/tenant to `enqueueEmployerIconResolution`. That is one deduplicated `INSERT` keyed by `(canonical_employer_id, evidence_fingerprint)`; no provider or model is called on the ingestion path, and the insert is skipped when the employer already has a reviewed icon or a live decision. Employers that predate the resolver are seeded the same way by a bounded backfill, and each backfilled task carries the employer's own live posting link when the catalog still has one, so it resolves with the same page evidence — including the site its board or Organization node declares — as a fresh admission instead of on the name alone.
2. **A sweep resolves it.** The ten-minute maintenance cron calls `runEmployerIconResolutionPass`, which claims at most `maxPerSweep` due rows with a lease. The sweep reads the real application link through the existing SSRF controls (`safeFetchText`, five redirects, 10s, 512 KiB), presenting an identifying user agent and `Accept: text/html` (`NternCompanyIcons/1.0 (+…; read-only)`), parses only bounded public metadata (`<title>`, OpenGraph, JSON-LD `Organization` name and URL), and asks Logo.dev and Brandfetch for domains by employer name — first under the catalog's name, then under the names the employer's own board and page declare about itself (the board's organisation name, a structured-data `Organization.name`, the Open Graph site name), then under the employer's distinctive brand token. Every query is matched against the name that was asked for, each employer asks at most four, and the query that actually reached the provider is logged (`company_icon_provider_query_won`), because that is the only way to know whether the extra names earn their requests. A posting page larger than the ceiling is **truncated, not rejected**: the employer's name is in the first few kilobytes of `<head>`, and a two-megabyte Lever page must not cost that employer its icon. A page that answers **non-2xx** is a retrieval failure, not a page that happens to say nothing: it yields no evidence, records `pageFailure`/`pageStatus` for the reviewer, and a rate limit or bot wall (403, 406, 408, 425, 429, 5xx) takes the one-hour transient backoff while a withdrawn or malformed posting takes the long one.
3. **Scoring decides.** Candidates are scored from the reviewed table — non-ATS final/careers URL 0.45, the reviewed application host of an officially-admitted role 0.40 on top of that, JSON-LD Organization 0.35, each provider's exact-name candidate 0.30, both providers agreeing on one domain 0.25, employer-identity evidence naming the employer 0.15, capped at 1.0. ATS and job-board hosts are transport and are rejected outright. A domain is accepted automatically only at 0.85 or above with a 0.15 margin over the runner-up.

   The 0.40 exists because a role admitted from an official ATS, structured, or employer-submitted source has already had its destination reviewed as the employer's own application form. If that form is served from a host that is not a transport platform, that host *is* the employer's application host, and nothing further needs to confirm what the catalog already established. Community listings are deliberately excluded: their links are not the employer's own destination. Scores are settled to six decimals before the threshold comparison, so `0.45 + 0.40` cannot miss 0.85 to a binary rounding error.
4. **A domain that names itself settles the decision, before the model is asked.** When the score alone could not decide, up to three non-rejected candidates are fetched — strongest first — and each must name the employer in its own metadata: the same proof a proposal needs. Exactly one confirming is a decision, recorded as `selected_source = 'confirmed'`; two confirming is a genuine tie and stays with the model. This runs on every undecided employer, not only the middle band, because a platform-hosted posting can produce a single candidate and the alternative would be to ask the model about a domain the domain itself could have settled. Measured on a 23-employer sample, it took coverage from 19/23 to 20/23 and reduced the model to a tie-breaker in the literal sense.
5. **One tie-breaker for the middle band.** The resolver may make **one** schema-validated `gpt-4o-mini` call when the best score is in 0.55–0.84, when the top two candidates are within 0.15, or when the best candidate already carries two independent evidence IDs (a candidate the tie-breaker could actually accept, since its own rule requires exactly that). It receives only a compact JSON summary, may select only a submitted candidate, must cite at least two distinct evidence IDs that belong to that candidate, and is accepted on its own word at **0.80** confidence. Below that — down to a 0.30 floor — an otherwise valid answer is **not** refused but set aside for verification: the resolver fetches the selected domain and requires it to name the employer in its own metadata, exactly as it does for a proposal. The budget is one call per employer per 30 days, except when the job-link evidence materially changed.

   That second tier exists because of what the real model does. Over a 23-employer sample of the live catalog, `gpt-4o-mini` selected the **correct** domain at 0.45–0.80 thirteen times and reached 0.90 once; refusing those was losing employers we could prove. Eleven of those thirteen answers were confirmed by fetching the domain and finding the employer named in its own title. A self-reported confidence is a guess; a domain that names the employer is evidence, and the tier accepts on the evidence. The verifications are logged as `company_icon_resolution_tie_break_verified` with the domain and the model's confidence, so an operator can audit them.
5. **A domain may be proposed when there is nothing to rank.** On a platform host the page can prove *who* is hiring and still name no domain, so when the candidate set is empty the same single model call is used in proposal mode: it answers with a registrable domain, and **nothing about that answer is trusted**. Transport hosts are refused outright, the proposed domain is fetched through the same SSRF controls as any other link, and it must present itself as this employer in its own metadata — naming either the catalog name or the name the employer's own board declares. A proposal that fails verification is recorded and discarded, and an accepted one still passes the verified-image gate, is stored as `selected_source = 'proposed'`, and carries a `proposed-domain` evidence ID so the review queue can tell how it was decided.
6. **Failures back off.** A definitive no-match retries from one day, doubling to the 30-day revalidation ceiling. A transient provider failure (429/5xx/transport) retries from one hour and honours `Retry-After`.

### What the evidence can and cannot prove

Two posting shapes carry very different evidence.

**On the employer's own domain** (a direct careers link, or an employer-hosted ATS riding a vanity host): the link itself proves the domain, and the page usually confirms the employer in its title, OpenGraph, or structured data. A Workday-backed role that starts on `jobs.intel.com` and redirects into a Workday host resolves to `intel.com` off the redirect chain, and the Workday host is rejected as transport.

**On a platform host** (`job-boards.greenhouse.io`, `jobs.lever.co`, `jobs.ashbyhq.com`): the page proves *which employer is hiring* — the title usually ends in `at <Employer>` — but never names the employer's domain, because the host is transport. Here the provider's nomination carries the domain and the page carries the identity.

Four kinds of employer-identity evidence are collected, and any two are enough to send one candidate to the tie-breaker:

1. **The posting page** naming the employer in `<title>`, OpenGraph, or JSON-LD Organization. Compared after corporate suffixes *and* organizational qualifiers are removed, so a page showing the brand alone still counts for a catalog name like `Palantir Technologies` or `Flagship Pioneering Co-Op Program`.
2. **The structured Organization block**, whose domain is read from `url` *and* `sameAs`. Publishers routinely use `sameAs` for an Organization's site — Stripe's own `hiringOrganization` does — and reading only `url` left this entire 0.35 evidence class dead in production. A profile URL in `sameAs` is collected but can never become a candidate, because social platforms are transport.
3. **The provider's own reported brand name**, matched symmetrically: it must contain every distinctive employer term and add no distinctive term of its own. `Flagship Pioneering` describes `Flagship Pioneering Co-Op Program` and `IMC Trading` describes `IMC`; `Scale Computing` never describes `Scale AI`.
4. **The posting's reviewed ATS board slug**, compared against the canonical employer ID on whole segments and affixes from four characters. It is independent of whatever domain a provider nominates, and it carries the case where the page is challenge-gated or names an agency (`axontalentcommunity` hosts `axon`).

Each provider is searched twice when the first attempt finds nothing: once with the full catalog name and once with the employer's distinctive brand token, because real catalog names are not what a search index holds (`Flagship Pioneering Co-Op Program` versus `Flagship Pioneering`). A third query uses the name the employer's own ATS board declares, which is what makes a renamed employer reachable at all: the board says `Rivian and Volkswagen Group Technologies` where the catalog says `RV Tech`. Every attempt matches the provider's answer against the name it asked for, and a query that fails or finds nothing does not stop the ones after it.

### What a platform declares about its employer

The posting page is already fetched for evidence, and the platforms publish more than a title in it:

| Platform | Employer's own site | Employer's name |
|---|---|---|
| Ashby | **`publicWebsite`** in the board payload, else the careers page it hosts | page title |
| Greenhouse | **`logo.href`**, the destination of the employer's board logo (null when unlinked) | **`company_name`** |
| Lever | not published | page title |

Either declaration is read from the page in hand, so it costs no extra request and no credential. An Ashby board's `publicWebsite` is the employer's own statement about its domain, so it carries the same weight as a JSON-LD Organization URL, and it is what lets an Ashby-hosted role resolve with no provider configured. Greenhouse publishes the same fact as the destination of its board logo (`logo.href`), and a board that links its own posting host there is read as a transport host and discarded.

When the employer's own board or Organization node declares a site and the providers agree on a *different* domain — or merely a close one — the employer's own declaration wins: two providers agreeing with each other is how a namesake gets published, whereas the declaration is the employer stating its own site. This override needs no model call, so an unambiguous case such as `meta.com` beside the `metacareers.com` careers host resolves deterministically. A domain that is only a final URL, a provider nomination, or a page title cannot trigger it; it is strictly the employer's own declaration.

A declared name is only used when it denotes a company. ATS boards sometimes carry a landing-page title — Axon's board declares `Join Our Talent Community` — which names a page rather than an employer and would send a provider search and a logo lookup in the wrong direction, so those are rejected.

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
| Platform host (26) | none | yes | **23** | **23** | **0** |
| Platform host (26) | Logo.dev | yes | 26 | 26 | **0** |
| Platform host (26) | Logo.dev + Brandfetch | yes | 26 | 26 | **0** |

The platform-hosted cohort went from 5 to 23 published with **no provider configured at all**, and 18 of those 23 were decided by a domain the model proposed and the domain itself then confirmed. The three that remain are domains that refuse to identify themselves to our fetch — `genscript.com` and `worldquant.com` answer 403 and `togetherai.ai` renders its name client-side — so the resolver declines rather than publishing on the model's word alone. A provider resolves those, because a provider nomination does not depend on the domain answering us.

The own-domain cohort is complete **without any provider at all**. Before the reviewed application host counted, eight employers — Coinbase, Jump Trading, Jane Street, Goldman Sachs, OpenAI, Uber, Tesla, and Google — were stranded at 0.45 with a single evidence ID, so they rendered a monogram even though their own application link was in hand. They now resolve automatically at 0.85.

Four platform-hosted employers are excluded from the denominator because no domain of theirs could be verified at all; they are program or confidential boards (`walleyecapital-external-students`, `samsungresearchamericainternship`, `stackadapt-confidential`, `toshiba-global-commerce-solutions`).

Read across: a role on the employer's own domain needs no provider, and a platform-hosted role is now mostly resolvable without one too. Provider consensus resolves every platform-hosted employer automatically, and Logo.dev alone reaches all of them. What remains a monogram is a domain that will not confirm who it belongs to.

**The residual risk of a proposal is a name collision.** Verification asks whether the domain presents itself as this employer, and two companies can share a name — a domain titled `ACME Industrial Supply` does confirm an employer named `Acme`. That risk is inherent to any name-to-domain lookup, including a provider's own search, and it is bounded by the same guardrails: observe mode before anything is rendered, the exception queue, and `report-wrong` withdrawing a decision within a minute. Proposal decisions are marked `selected_source = 'proposed'` so they can be reviewed as their own class.

### How good is Logo.dev on our own catalog?

`npm run coverage:icons -- --provider-audit` answers this directly: it runs **only** Logo.dev, over a cohort of employer names — no page fetch, no model, no decision — and reports what its search returns and whether its image endpoint then holds a real logo. That separates the provider's coverage from everything this resolver layers on top, and the failure classes have different fixes.

| Cohort | Names | Search + image usable |
|---|---:|---:|
| Mapped employers (the population the sweep acts on) | 158 | **148 = 94%** |
| Wider catalog, including companies with no canonical employer | 147 | **138 = 94%** |

Failure classes, with counts from the 158-name run:

| Outcome | Count | What it means | Fix |
|---|---:|---|---|
| `usable` | 148 | a domain under a matching name, with an image | — |
| `name-mismatch` | 6 | the search **returned results**, none of which passed our name rule | **our matcher** |
| `no-image` | 4 | a nominated domain with no logo in the index | site-asset fallback, or a reviewer |
| `no-results` | 0 | nothing in the index for the query | — |

The name rule itself was the first fix, and it is worth restating what it now does, because the line it draws is the difference between coverage and a wrong logo. A provider match is either **`2`** — the same name under our canonical rules, including "does not add a distinctive term of its own" — or **`1`**, the same name written the way the brand writes it: punctuation and spaces removed (`Rendezvous Robotics` → `rendezvousrobotics`), a domain-shaped entry (`rivetindustries.com`), and program words the catalog carries but the index does not (`Walleye Capital Internships` → `Walleye Capital`, `Acme Summer 2026 Students` → `Acme`). A `1` is a candidate, never a final answer: the resolver keeps asking the remaining names and takes a `2` if one arrives, because a search for "Appian Corporation" answers with the domain-shaped `appiancorporation.com` — which has no logo — ahead of the brand's own entry.

Strength `0` is where the matcher stays deliberately strict: equality, never containment, so `Bree` does not match `Breeze`, `N1` does not match `Nexl`, `Apple` does not match `Apple Bank`, and `Scale Computing` does not match `Scale AI`. The remaining mismatches are exactly that class — short or ambiguous names — plus two cases we choose not to guess at (`Optiver - ICML`, `Medecins Sans Frontieres (Doctors Without Borders)`), which the domain-verification path settles instead.

The failure that mattered was the second row, and reading the actual responses showed why. Our rule requires the provider's entry name to equal the employer name, and the index stores brands the way brands write themselves:

| Catalog name | What Logo.dev returns | Correct? |
|---|---|---|
| `Rendezvous Robotics` | `rendezvousrobotics` → rendezvousrobotics.com | yes — spaces |
| `Walleye Capital Internships` | `Walleye Capital` → walleyecapital.com | yes — program suffix |
| `Optiver - ICML` | `Optiver` → optiver.com | yes — event suffix |
| `Lila Sciences` | `lilasciences` → lilasciences.ai | yes — spaces |
| `Medecins Sans Frontieres (Doctors Without Borders)` | `Doctors Without Borders` → doctorswithoutborders.org | yes — parenthetical |
| `Toshiba Global Commerce Solutions` | `toshibaglobalcommercesolutions` → …solutions.com | yes — spaces |
| `Bree`, `N1`, `k-ID` | Breeze, Breedon, Nexl, Netflix… | **no** — short or ambiguous names |

So of eleven apparent misses, **eight were the correct domain already in the index**, rejected because the catalog writes `Rendezvous Robotics` where the brand writes `rendezvousrobotics`. Measuring the fix beat estimating it: the two cohorts moved from 92% to **94%**, and the remaining non-usable names are the short and ambiguous ones (`Bree`, `N1`, `k-ID`, `Super`) where the index holds nothing under a name we could accept.

Two limits on this measurement, stated because they bound the answer. It measures *a logo for the domain the provider names under a name we accept*, not that the logo is the right one for the legal entity — a subsidiary can resolve to its parent's mark. And both cohorts are ATS-posted companies, which skew towards technology employers with real websites; employers that never post to Greenhouse, Lever, or Ashby are not represented at all.

### Measured with real credentials and a real model

Everything in this section ran against the live catalog with the account's own Logo.dev credentials and the real `gpt-4o-mini`, through the resolver itself and nothing else: no simulated provider, no human standing in for the model, no write of any kind. The cohort was a random 23 employers from the mapped set.

| Path | Result |
|---|---|
| Logo.dev name search | **nominated 21/23**, and has a real logo image for **30 of the 34 domains** it nominated — 21 of 23 employers |
| Board logo, same employers (`npm run coverage:icons`) | **14/23** |
| Domain path (real provider, real model) | **19/23** — greenhouse 12/14, ashby 7/9 |
| **Union** | **21/23 (91%)** |

The resolver needed the model for only **4** of its 19 resolutions. Fifteen were decided by proof: a candidate our own evidence already corroborated (two or more independent evidence ids, so there was nothing to choose between) whose domain, fetched, names the employer in its own metadata. That ordering is deliberate — the proof is the same one a proposal needs, so it can only accept a domain a proposal could have justified, and it costs a fetch instead of a model call and the employer's 30-day budget.

None of the 19 reached the 0.85 automatic threshold, because with one provider the score tops out at 0.60–0.75. **That is the argument for Brandfetch**: consensus between two providers is what clears the threshold with no call at all, and Brandfetch was unconfigured in this run.

The two remaining monograms are the honest remainder, and both are the exception queue's business: `replit`, whose nomination carries our corroboration bar for one domain but not the trademark-confirming one, and `stackadapt-confidential`, whose board did not answer us and which Logo.dev does not index.

Two risks this measurement makes explicit. A corroborated candidate is accepted on self-confirmation, so a namesake domain that presents itself under the employer's name could be chosen over the right one — mitigated by the two-independent-evidence requirement, the exact-name provider rule, observe mode, the recorded evidence ids, and `report-wrong`, but not eliminated. And a single-provider deployment leans on the model or on proof far more than a two-provider one; the counters below are how an operator sees which case they are in.

Superseded by the above: the earlier cohort table in this document was produced with **simulated** providers — deterministic stand-ins with no credential in the checkout — and a human answering the tie-breaker from the same bounded JSON the model receives. Its accuracy claims about scoring, attribution, and validation still hold, because those rules were real; its provider hit rates and its model behaviour do not, and are replaced here.

### The employer's own uploaded logo

The best icon is the one the employer put on its own board, and every supported platform publishes it. The posting page is already fetched, so this is read from the page in hand — no provider, no credential, and no identity inference, because the page *is* the employer's own posting and the asset is on the platform's board-logo host.

| Platform | Field | Host |
|---|---|---|
| Ashby | `logoSquareImageUrl`, else `logoWordmarkImageUrl`, else its social card | `app.ashbyhq.com/api/images/org-theme-*` |
| Greenhouse | board `logo.url`, else `og:image` | `s<N>-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/…` |
| Greenhouse | `banner_url`, else the rendered `<img class="banner">` — last resort, shape-gated | `…cdn.greenhouse.io/job_board_renderer/job_board_configurations/banners/…` |
| Lever | `og:image` | `lever-client-logos.s3[-us-west-2\|.us-west-2].amazonaws.com/…` |

Each platform is matched on the hosts and paths it actually uses for board logos, so an unrelated `og:image` — a role banner, a client's CDN, a share card — is never picked up. Candidates are ranked by format before source, because Ashby serves some boards an SVG that cannot be stored while the usable raster sits beside it, and a caller that finds one unusable falls through to the next.

Greenhouse forced two reads beyond `og:image`. Its current board renderer emits `<meta property="og:image"/>` **with no value** for a board whose logo was never uploaded, and serializes the board payload escaped inside a script (`\"logo\":{\"href\":…,\"url\":…}`), so both the board logo and the banner are read from there, tolerating the escaping. The banner is the employer's own uploaded art, but it is a promotional strip as often as it is a mark — a photo, a tagline, a collage — so it is the last candidate and is stored **only when its own pixels are roughly square** (0.75–1.34). A 1400×300 careers banner cropped into a square tile shows a slice of a photograph, which is worse than the monogram it replaced, so it is refused and the refusal is logged as `banner-not-square`.

Measured with `npm run coverage:icons` (read-only, real page fetches and real asset rules) across the employers the sweep acts on — every canonical employer with a reviewed ATS mapping, reached through a live posting on that platform's own host:

| Platform | Employers | Uploaded logo usable |
|---|---:|---:|
| Ashby | 59 | **42** (71%) |
| Greenhouse | 96 | **65** (68%) |
| Lever | 1 | **1** (100%) |
| **All** | **156** | **108 (69%)** |

Greenhouse's 32% is a real property of the boards, not an extraction failure. Re-running the **previous** extraction over the same 96 pages yields exactly the same 65, so no field was being missed: 26 boards published no art on any host the rules accept, four published only a promotional strip, and one (`faire`) answered 403. What the new reads did change is visible elsewhere in the catalog: a board whose *only* art is a square banner is now usable — `aquaticcapitalmanagement` publishes a 3350×2606 mark in the banner slot and nothing else, verified by fetching it — and a board that publishes only SVG is now logged as `svg-not-servable` rather than mistaken for a board with no art.

One measurement detail worth recording, because it forced the failure rule below. After roughly 1,500 page reads from a single host, the platform's edge began answering **406 Not Acceptable** for every job page and board root from that host, with every user agent tried, while `boards-api.greenhouse.io` kept answering normally. The same URLs fetched through Cloudflare's own egress with the resolver's identifying user agent answered **200**, so production is unaffected and no browser-like user agent is needed. What the episode revealed is that an error page was being read as the employer's posting at all; it is now a retrieval failure with `pageFailure`/`pageStatus` recorded and the transient backoff, which is the honest treatment of a bot wall.

Three details the measurement forced. Lever's bucket serves its logos as `binary/octet-stream`, so a declared content type cannot be the only evidence — the asset type is settled from the bytes when the header is useless or missing, and an asset is stored only if it resolves to a raster. Ashby serves some boards an **SVG** square logo — from a `.png` path, so the URL says nothing — and an SVG document is never stored as-is, because opening one directly runs its script on the API origin: the raster beside it is used when the board publishes one, and the document is rasterized when it does not. And Greenhouse's remaining third is not a parsing problem at all: those boards publish no art, so those employers fall to the domain path.

Ashby serves some boards an **SVG** square logo — from a `.png` path, so the URL says nothing about the format, and the bytes are the only evidence. Three employers with reviewed mappings publish *only* SVG today: `snowflake`, `droyd`, and `tribalscale`. Those documents are **rasterized**: the resolver renders the SVG with resvg (WebAssembly) and stores only the PNG, so what reaches a client, an R2 key, or the API origin is never the publisher's document.

The pipeline around the renderer is deliberately strict, because the input is untrusted:

1. `iconSvgAsset` decides a candidate *is* an SVG, from its declared type or its bytes (a bucket that declares `binary/octet-stream` can still hold one).
2. `safeIconSvg` narrows it to a bounded, inert document: at most 512 KiB, valid UTF-8, root element `<svg`, and no `<!DOCTYPE>`/`<!ENTITY>`, `<script>`, `<foreignObject>`, embedded-document element, `on*=` handler, `javascript:` URL, non-`data:` scheme or protocol-relative `href`/`src`, or `url(//…)`. A document that would need rewriting to be safe is refused, not rewritten, as `svg-unsafe`.
3. The renderer draws it at 256 px wide, with system fonts disabled — resvg would otherwise reach for a filesystem a Worker does not have, and a mark that is nothing but live text is not one we store.
4. The result must be a PNG within the size ceiling, and a **banner** is shape-checked *after* rasterization too, because that rule is about the picture rather than the container it arrived in.

The module is uploaded as its own Worker part, `resvg.wasm` (`application/wasm`), named by `scripts/prepare-worker-modules.mjs` so the part key equals the import specifier and no content hash lands in `infra/cloudflare/main.tf`. Only the ingestion bundle imports it — the API Worker never resolves icons — and the import is deferred until the first SVG has to be rendered, so a run that meets no SVG never compiles it. The deploy plan guard permits exactly that part and nothing else new: a `files` change must carry `application/wasm` parts whose paths end in `.wasm`, and a wasm-only update counts as a code change rather than as drift.

Cost, measured: the ingestion bundle goes from 1.27 MB to 2.20 MB compressed, and the renderer adds ~1 ms for a board logo after a one-off module compile. That is the whole reason this was worth wiring rather than shipping a provider-only fallback for three employers: it removes a permanent class of "board publishes only SVG" misses without a provider, a credential, or a request at render time.
The bytes are copied into our own bucket under `company-icons/<id>/platform-<hash>.<ext>`, so rendering never depends on the platform's CDN and no third-party request happens at render time. The key is recorded with `icon_source = 'platform'`, which is what an operator sees in the exception queue, and `report-wrong` withdraws it like any other automatic decision. A reviewer's icon is never overwritten, and the icon is stored even when the employer's *domain* stays undecided — the icon and the domain are separate facts, so `icon_resolution_status` is left alone.


### When the board publishes nothing: the employer's own site

A third of platform-hosted employers publish no board art at all, so the sweep falls back to the employer's **own verified site** — the same domain the decision above just established, which is what makes reading it safe. Only **declared** assets are read, in the order a site publishes them as its brand mark:

| Order | Field | Why |
|---|---|---|
| 1 | `<link rel="apple-touch-icon" sizes="…">`, largest first | square, drawn for a tile |
| 2 | JSON-LD `Organization.logo` (a URL or an `ImageObject`) | declared as the organisation's logo |
| 3 | `og:image` / `twitter:image` | a marketing crop; kept only if it survives the shape rule |
| 4 | `<link rel="icon">` | usually 16–32 px, so it is last |

A screenshot, a hero image, or any other `<img>` on the page is never a candidate: the extraction reads declarations, not pictures. Every candidate then passes the same gates as a board logo — https, ≤2 MiB, a raster (or an SVG through the sanitizer and renderer), **at least 64×64**, and a roughly square shape (0.75–1.34). Bytes are stored as `company-icons/<id>/site-<hash>.<ext>` with `icon_source = 'domain-asset'`, a distinct provenance so a reviewer can tell an asset read off the employer's own site from one the employer uploaded to its board, and `report-wrong` withdraws either.

Order of sources, cheapest first. If the posting itself is on the employer's own domain, the page already fetched for evidence **is** the page that declares its mark, so those assets are read first and often settle the icon with no extra request at all. Otherwise the domain's homepage is fetched — the page a visitor lands on, and often the one that declares the touch icon a sub-page omits. The fallback runs **after** the provider, not instead of it: a logo from the index is already a curated square mark, and the site path is the net for the cases where the provider has nothing for the domain, or no credential is configured to ask with. Measured on the domains that published through Logo.dev in the 23-employer sample, **12 of 17 declare a usable square asset of their own** (Apple touch icons, webclips, and ≥196 px favicons), which is what the fallback is worth when the provider's index misses.

### A model may name an asset — inside one verified domain

This is the single place the resolver breaks its own rule that a model nominates a *domain* and never an asset, and it is deliberately narrow. When the declared assets all fail the gates and the employer still has its one bounded call for the window, the model is asked once for the company's mark. It may answer with:

- one of the declared assets it was shown (`kind: submitted`), or
- **another https URL on the employer's own verified domain** (`kind: nominated`) — the case this exists for, where the mark sits at a path the extraction did not know about.

Anything else is dropped *before a request is made*: an off-domain host, a lookalike domain (`acme.com.evil.test`), plain http, a missing or too-weak answer (below 0.5 confidence). A nominated URL is then fetched and gated exactly as any other asset — https, host on the verified domain, raster or SVG, ≤2 MiB, ≥64×64, shape — so the model's answer can move our request within a domain we already proved, and can never point us outside it, and can never cause a stored byte that a deterministic asset could not have caused. The nomination is logged (`company_icon_domain_asset_nominated`) with the URL, whether it was a pick or a nomination, and the model's confidence, and the acceptance is recorded as `assetSource: 'model'`.

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

- **Logo.dev** supplies both the name search and the icon, through **two different credentials that are not interchangeable**. The secret key (`sk_…`) authorizes the name search and is answered with `401` by the image endpoint; only the account's publishable token (`pk_…`) authorizes `img.logo.dev`. Provisioned as `LOGO_DEV_TOKEN` and `LOGO_DEV_IMAGE_TOKEN`, with `LOGO_SECRET_KEY` accepted for the first and `LOGO_PUBLISHABLE_KEY`, `LOGO_DEV_PUBLISHABLE_KEY`, or `LOGO_DEV_PUBLISHABLE_TOKEN` for the second, so a checkout that already carries any of those names works unchanged. Neither is an `EXPO_PUBLIC_*` value, and neither appears in a response, an R2 key, or a log. The publishable token is the one Logo.dev itself embeds in every `logo_url` a search returns; it is safe to expose in an image URL by design, and the resolver still keeps it server-side.

  Passing the secret key where the publishable token belongs is not a subtle failure: the image probe returns `401` for every domain, so nothing provider-sourced can ever be verified or published. That configuration is now named as its own state — `image-token-missing`, retryable within the hour, with a `company_icon_resolution_image_token_missing` log line — instead of looking like an employer whose domain has no logo.
- **Brandfetch** is corroboration only. Its standard Brand Search terms forbid persisting its data, so its results are used in memory, are never written to `employer_icon_resolutions`, and its logo is never fetched or stored. Only a bare agreement flag is recorded, and a candidate that only Brandfetch nominated is omitted from the stored evidence.
- **Simple Icons and favicon services are not used.** The mobile client previously carried a hardcoded map of `cdn.simpleicons.org` and `icons.duckduckgo.com` URLs; it has been removed in favour of the first-party route and the monogram.

### Serving an automatic icon

`GET /company-icons/:id` resolves in this order:

1. an `icon_key` in `DOCUMENTS` — the employer's uploaded board logo, or a cached provider icon, or a reviewer's upload;
2. an automatically resolved domain, fetched server-side from the provider CDN and returned with the same security headers.

A key a **machine** wrote (`icon_source = 'logo-dev'` or `'platform'`) renders only once the operator has left observe mode. A reviewer's upload always renders. Without that gate a stored key would route around the observe switch, which matters precisely because the uploaded logo is stored during observe mode so the later switch is instant.

The second path exists so a provider credential never reaches a client, a catalog payload, or a stored key, and provider image bytes are **not** written to R2 while Logo.dev self-hosting rights are unconfirmed — the employer's own uploaded logo is a different asset and is stored, because the employer published it on its own board. The image probe requests `fallback=404`, so Logo.dev's generated monogram tile can never be served as if it were a real logo.

Responses carry `max-age=60, stale-while-revalidate=86400, stale-if-error=86400`: a reader is served a cached icon at once and the copy refreshes in the background, so a wrong-icon report still lands within about a minute without anyone waiting on the provider fetch. While retention is unlicensed the read path only ever serves those bytes through this origin; once it is licensed the first read also stores them (see below).

Icons are served from the custom domain `api.ntern.app`, because Cloudflare's Cache API never populates on `workers.dev`. The Worker's icon route reads and fills that cache, so a warm colo answers without a D1 read or a provider fetch. The zone's default Browser Cache TTL would otherwise rewrite the icon's `max-age` to four hours, so a scoped cache rule (`http_request_cache_settings`, `api.ntern.app/company-icons/*`, browser and edge TTL `respect_origin`) keeps the interval honest; it is configured through the Cloudflare API, not OpenTofu, the same way the R2 lifecycle rule is. Everything except icons stays on the `workers.dev` API origin, so cookies, signed URLs, and CORS keep one origin.

Once the Logo.dev plan confirms self-hosting and retention, record the confirmation and both the resolver and the read path cache the icon instead. The read path stores the first provider image it serves, so an employer resolved before the confirmation is cached the first time someone views it rather than waiting on a re-resolution:

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
| `POST /internal/admission/employer-icons/resolve` | Force a fresh decision for one employer, and re-arm one whose automatic decision was withdrawn. Re-arming re-uses the employer's own task, so a resolve never seeds a second one. |
| `POST /internal/admission/employer-icons/confirm` | Settle one employer by hand with a bare hostname. Rejects an ATS or job-board host and refuses a domain with no real logo, so a person can name a domain but never vouch for a broken icon. |
| `POST /internal/admission/employer-icons/report-wrong` | Withdraw an automatic icon immediately and sort the employer to the front of the exception queue. A reviewer-uploaded icon is never withdrawn. |

A wrong-icon report is deliberately terminal for the automatic path: the sweep will not re-decide that employer until a person has looked at it. Once the review is finished, `resolve` re-arms the withdrawn rows, and the next sweep decides again from fresh evidence. An employer the resolver has never swept has no task row to withdraw, so the report writes one `invalidated` row of its own: a report always appears in the exception queue rather than leaving the employer silently withdrawn. `resolve` then re-arms that row, exactly as it would a swept one.

A `confirm` on an employer the resolver has never swept is settled the same way: the canonical decision is written with no task row, so the backfill and any later admission skip it and a stale task seeded by an earlier deploy is dropped rather than allowed to overwrite the confirmed domain. That is different from an *automatic* resolution, which always leaves its resolved task row behind and is therefore still re-validated: after the 30-day window a fresh admission seeds a new task and the sweep decides again. `resolve` is the deliberate override for both: it clears the settled status and re-arms the rows, so a confirmed domain can be re-looked instead of being permanent.

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

# How much of the live catalog the employer's own uploaded board logo covers, per
# platform, and why each miss is a miss. Real fetches, real asset rules, nothing written.
npm run coverage:icons
npm run coverage:icons -- --platform greenhouse --json
```
