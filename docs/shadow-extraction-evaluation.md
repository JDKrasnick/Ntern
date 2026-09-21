# Shadow extraction evaluation

We use [Braintrust datasets](https://www.braintrust.dev/docs/guides/datasets) as the optional experiment ledger because this service is TypeScript-first and supports versioned records with `input`, `expected`, and `metadata`. The repository remains the deterministic evaluator: it can replay recorded responses without an API key or model call. A `BRAINTRUST_API_KEY` is deliberately not required for local evaluation, and no production artifact is uploaded implicitly.

## Bounded production suite

`scripts/prepare-shadow-production-eval.ts` freezes a maximum-50 manifest:

- 25 independently reviewed first-completed natural `provider-poll` runs for the pinned schema/prompt/model; these are the development split.
- 25 non-overlapping rows selected by a read-only `ORDER BY random()` sample and then frozen by run key; these are the holdout split.

The holdout is intentionally not used to tune a rule. It must receive independent human labels before it can accept or reject a postprocessing change. Keep the manifest, downloaded artifacts, labels, and reports under ignored `eval/` or `.context/`; they contain official-posting source text and response evidence.

## Commands

Create the frozen manifest from two read-only D1 query JSON files:

```sh
npx tsx scripts/prepare-shadow-production-eval.ts \
  --cohort .context/first-25.json \
  --random-pool .context/random-pool.json \
  --out eval/shadow-production-eval-manifest.json
```

Run the reviewed development split against the baseline and the conservative role-scope guard:

```sh
npx tsx scripts/evaluate-shadow-postprocess.ts \
  --manifest eval/shadow-production-eval-manifest.json \
  --artifacts .context/shadow-artifacts \
  --report eval/shadow-postprocess-audited.json
```

The existing `npm run eval:shadow:offline` remains the model-output replay command. Use `npm run eval:shadow:live -- --limit 50` only after the 50-case ceiling and model cost are intentionally approved.

## Guard experiment

`postprocessRoleScopedExtraction` is a reversible experiment and is not connected to publication. It only clears a present claim when that field’s supplied evidence is unmistakably generic company copy:

- E-Verify or statutory wage language is not work-authorization eligibility.
- Generic hybrid-benefit language is not the role’s work mode.
- Headquarters or office-listing prose is not the role’s location.

It never fabricates a field the model missed. Do not enable it in the Worker until the frozen random holdout is labelled and meets the per-field release gates.
