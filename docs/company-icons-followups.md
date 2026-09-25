# Company icons — follow-ups and handoff

The resolver is live in production in `resolve` mode. This is the work that is deliberately
not done yet, in priority order, plus how to operate what is there.

Context: [`docs/company-icons.md`](company-icons.md) is the design; the first production sweep
and a read-only evaluation are the evidence behind these items.

## 1. In-app "report a wrong icon" affordance (needs a product decision)

The server path is complete and tested: `POST /internal/admission/employer-icons/report-wrong`
withdraws an automatic icon immediately and sorts the employer to the front of the exception
queue, and a reviewer-uploaded icon is never withdrawn. What is missing is the client entry
point.

- Surface a long-press / "…" action on the employer row in the roles feed that posts the
  report for the employer currently shown.
- Keep it to one tap with no confirmation dialog if the action is reversible (it is — a
  reviewer restores it), and show a plain acknowledgement ("Thanks — we'll take another look").
- The id to send is the canonical employer id already on the role; the client resolves the
  first-party icon route from it today.
- Decide whether an anonymous device may report (it is the only signal that surfaces a wrong
  auto-publish from real users) or whether it requires the account; the server route is
  operations-gated today, so an in-app path needs a small public endpoint that records a
  report without the operations key.

## 2. A name-collision guard for ambiguous names

Two classes survive every deterministic rule because the board declares nothing:

- `freeform` → `freeformspaces.com` (a Boise office-furniture company; the catalog's Freeform
  is the ex-SpaceX 3D-printing company `freeformfuture.com`).
- `kirin` → `kirin.co.jp` (the Japanese beverage group; the catalog's Kirin is a Shenzhen
  venture brand whose Ashby org slug happens to be `kirin`).

The employer's own declaration fixes the class where a board or Organization node names a
site (that is what fixed `meta.com`, `figure.ai`, `kensingtontours.com`). When nothing is
declared, two providers agreeing on a namesake still wins. Options, cheapest first:

- **Prefer a declared domain over an undeclared one even more broadly** — already done for
  `platform-website` and `jsonld-url`; consider reading declared/outbound links from the
  posting page (`<a>` to a non-transport host, `og:url`) as a weaker declaration.
- **Refuse auto-publish for dictionary-word / one-token names** (a curated list, or a check
  against a word list), routing them to the exception queue instead. Brittle but effective.
- **Require the domain to answer for itself** before auto-publishing on provider consensus.
  This does *not* catch a namesake that shares the name (`freeformspaces.com`'s title contains
  "Freeform"), so it is a partial guard only.

Whatever is chosen, the eval below keeps the count honest.

## 3. Residual risks and what to watch

- `freeform`, `kirin` (false positives) and `amarok` (miss: only "Amarok Capital" is nominated
  and the resolver correctly publishes nothing) are tracked as known failures in
  `test/fixtures/company-icon-eval.json`.
- A wrong auto-publish is invisible to the exception queue (which lists misses), so until the
  report affordance ships, **sample the `score`-path decisions** occasionally:
  `npm run eval:icons` is the repeatable way, and D1 holds the provenance
  (`selected_source`, `selected_domain`, `evidence_json`).
- `report-wrong` and `confirm` need the production operations key (see below).

## 4. Model evaluation harness

Added alongside the metadata evals:

```bash
npm run eval:icons              # real Logo.dev/Brandfetch + real gpt-4o-mini, read-only
npm run eval:icons:no-model     # deterministic score/declaration path only
```

It runs the same `diagnoseEmployerIcon` the sweep uses over `test/fixtures/company-icon-eval.json`
and scores the domain the sweep would publish against verified ground truth: `correct`,
`false-positive`, `miss`, or `inconclusive` (a page the platform refused, which is a retrieval
failure rather than a wrong answer). Reports land in `eval/company-icon-results.{json,md}`
(gitignored). Add cases as new hard employers are found; `--strict` exits non-zero on any
false positive if it is ever wired into CI.

Latest run: **17/20 correct**, 2 false positives (`freeform`, `kirin`), 1 miss (`amarok`).

## 5. Operating the resolver

- Mode lives in `system_state.company_icon_resolution` (`{"mode":"observe"|"resolve","maxPerSweep":N}`).
  Observe records decisions but withholds machine icons from readers; resolve publishes them.
- The backfill seeds employers admitted before the resolver, now carrying each employer's own
  posting link so it resolves from the page rather than the name alone. It runs
  `ICON_BACKFILL_PER_PASS` per ten-minute sweep; raise it with `maxPerSweep` together — the
  five-minute lease bounds how many can be processed in one pass, so very large values risk a
  second sweep claiming an in-flight task (idempotent, but duplicated work).
- The exception queue is `GET /internal/admission/employer-icons`; a wrong-icon report ranks
  `100`, an exhausted employer `10`, a fresh miss `0`.
- Both operations routes require `X-Operations-Key` = the production `OPERATIONS_SHARED_SECRET`.
