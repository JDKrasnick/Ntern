# Luna prompt v52 evaluation

Evaluated on 2026-10-15 using `gpt-6-luna`, medium reasoning, an 8192-output-token cap, schema v5 and preprocessing `exact-posting-markdown-v2`. Six sequential prompt-only candidates were run, reviewed, and revised. The selected experiment was v51; its exact system-prompt bytes are integrated as release prompt v52 to give the change a fresh cache identity.

No normalization, schema, validation, postprocessing, model settings, or publication rules changed. No deployment or historical publication occurred.

## Paired source results

Each iteration used the same 50 source artifacts. One unavailable posting remains a contract case but is excluded from factual scoring. Six ambiguous/conflicting field labels are excluded individually, leaving **337 field judgments over 49 usable roles**. These are single-reviewer whole-field judgments, including missing conditions and extra claims, not merely presence matches. A source fact must survive in the value or an applicable qualifier; evidence alone is insufficient.

| Run | Main change | Correct fields | Accuracy |
| --- | --- | ---: | ---: |
| v45 baseline | Fresh prior-prompt baseline | 328/337 | 97.3% |
| Iteration 1, v46 | Pay headers, exact sites, role/program terms and scope | 333/337 | 98.8% |
| Iteration 2, v47 | Education anchors and field boundaries | 333/337 | 98.8% |
| Iteration 3, v48 | Value completeness and duties versus timing | 333/337 | 98.8% |
| Iteration 4, v49 | Direct negative-policy definition and full academic clauses | 333/337 | 98.8% |
| Iteration 5, v50 | Self-contained eligibility claims; exclude generic audiences and undisclosed terms | 335/337 | 99.4% |
| Iteration 6, v51 → release v52 | Linked degree/experience alternatives, extended-hours requirements and foreign-dollar uncertainty | **336/337** | **99.7%** |

The remaining selected-prompt error is an omitted role-specific flexible-hours condition; its part-time status and February–January term survive. Final source review also found that omission in iterations 1, 3 and 4, correcting their preliminary scores downward by one field. The same completeness criterion was applied to every run; source labels were not changed during tuning.

Before optimization, six disclosed label amendments were frozen and applied equally to the baseline and candidates: two previously documented location corrections, removal of an inferred country from a city-only site label, and three explicit housing denials that the wire schema already defines as information to retain. The original labels and amendments remain in the local evidence bundle. This prevents label corrections from being mistaken for prompt gains.

The development cohort contains correlated roles and was used during tuning. Its score is not an untouched-test result, a fleet accuracy estimate, or an authorization to publish.

| Field | Baseline correct | Selected correct |
| --- | ---: | ---: |
| compensation | 46/47 | 47/47 |
| locations | 46/49 | 49/49 |
| workMode | 46/46 | 46/46 |
| housing | 48/48 | 48/48 |
| timing | 47/49 | 48/49 |
| education | 46/49 | 49/49 |
| eligibility | 49/49 | 49/49 |

Housing coverage here consists of three explicit denials and correct absences; it does not establish recall for affirmative housing offers. The synthetic contrast cases cover one conditional relocation offer separately.

## Held-back contrast evaluation

Sixteen synthetic contrast cases were authored and fingerprinted before viewing candidate outputs. The final prompt was selected and locked before evaluating this set. No further tuning followed its results.

| Prompt | Correct fields | Accuracy |
| --- | ---: | ---: |
| v45 baseline | 106/112 | 94.6% |
| Selected prompt | **109/112** | **97.3%** |

The selected prompt avoids the baseline's unsupported USD claim for a Canadian `$` amount, avoids treating a student recruiting label as an academic program, and preserves a multiline country/city worksite. Housing denial, conditional relocation support, export-control alternatives, explicit CAD pay, optional sites, and source-instruction rejection pass both runs.

Three failures remain in both prompts after postprocessing: a German onsite statement, a German duration written in words, and an “every workday” schedule. The model extracts these facts before the guard removes them. They were not used to tune or patch the held-back result. This sample is synthetic, small and single-reviewer; classification-discipline strings are outside this field score.

The cases are preserved in `test/fixtures/shadow-extraction-eval-3.json`. The eval CLI now accepts `--role-scope` to apply the existing guard during live or recorded scoring and marks reports with the selected path. This changes scoring only, not extraction or the guard. Reproduce the contrast check with:

```sh
npx tsx scripts/shadow-extraction-eval.ts --live --cases test/fixtures/shadow-extraction-eval-3.json --role-scope --record .context/v52-contrast-recorded.json --report .context/v52-contrast
```

Without that flag, the CLI scores direct validation. The flag does not add projection/repair; the source-cohort runner exercises those separately. All held-back contrast responses validated without repair, so recorded CLI replays with the flag reproduce 106/112 and 109/112. Raw scores must not be substituted for postprocessed scores.

## Replays of manually audited sources

The selected prompt was also replayed on the six acquired official artifacts from the manual audit:

- Kensington: Toronto/hybrid and schedule retained; no unsupported USD assertion. Its unstated currency still prevents returning the pay amount under the current contract.
- Later: Vancouver/term/education retained; no inferred onsite/remote claim. The dollar amount remains absent because currency is unspecified.
- Vast: both work sites, USD range with unknown period, and full export-control alternatives retained.
- Formlabs: weekly USD pay, role term, onsite site, and explicit denial of housing/relocation assistance retained.
- Skydio: degree-linked pay bands retained. Hybrid remains absent because the acquired structured work-mode header is omitted from normalized text.
- Modal: sites/PhD facts retained. Structured pay and onsite headers are still absent from ordinary normalized text; the ambiguous currency also needs a representation decision.

These are diagnostic replays, not natural acceptance-cohort evaluations. Closed/error-board acquisition and incomplete historical inputs remain separate operational problems. Prompt tuning cannot recover metadata absent from the input.

## Reproduction and rollout boundaries

The local `.context/verification/pr557-optimize/` evidence bundle contains all six prompt snapshots, fresh responses, raw/pre-guard/post-guard stages, label and input fingerprints, manual wrong-value adjudications, score scripts, the frozen selection record, held-back results, and validation logs. No credentials are copied into artifacts. Successful-response usage is recorded; at least one request timed out and retried without reported usage, so recorded usage is not invoice reconciliation.

Three stale timing labels in fixture set 2 were corrected to the existing contract: application deadlines are excluded, while full-time and role attendance requirements are timing. The source-cohort comparison above uses its separate frozen labels and does not benefit from those fixture corrections.

This release still requires exact-version natural review and dev validation before activation. The first-25 quality gate remains authoritative; these development/contrast/replay cases do not satisfy it. Missing headers, unknown-currency representation, multilingual guard behavior and source completeness remain open readiness work.

## Verification

Typecheck and lint pass. The full one-worker suite passes **3,407 tests with 314 existing skips**; compiled E2E passes **85 tests with one skip**. The 20 eval-fixture tests also pass, and recorded CLI replays reproduce both held-back scores. Integrated prompt bytes match the selected snapshot exactly; deterministic normalization, cache-key algorithm, repair, schema, validation and guard rules are unchanged.

One concurrent full-suite attempt timed out in a large ingestion fixture and Vitest worker communication. The affected 66-test file passed in isolation, followed by the clean full one-worker run. No timeout was raised and no new skip was introduced.

The experiment follows the generate–annotate–evaluate–revise cycle and manual-review guidance in [OpenAI's prompt optimization documentation](https://developers.openai.com/api/docs/guides/prompt-optimizer).
