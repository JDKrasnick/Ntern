# Issue #231 posting-identity recurrence handoff

## Current production evidence

The bounded production audit completed on 2026-09-29 with a clean structural
gate: no duplicate groups, alias conflicts, untracked quarantines,
presentation blockers, legacy occurrences, projection mismatches, duplicate
occurrence references, or dangling occurrence references. It measured 13,276
confirmed and 1,747 unconfirmed occurrences, for 88.37% confirmed coverage
against an 87.31% ratcheted floor.

Seven reviewed community sources still had at least three unresolved posting
identities: `simplify-summer-2026` (225), `speedyapply-swe-2027` (114),
`speedyapply-ai-2027` (106), `zapply-2027` (73),
`vanshb03-summer-2027` (62), `northwestern-fintech-2027-quant` (36), and
`canadian-tech-internships-2027` (16). These are remediation inventory, not
evidence that a passing structural audit regressed.

`vanshb03-summer-2027` needed no operator recovery. Its 2026-09-29 14:27 UTC
scheduled run was `success_unchanged_hash`, with 371 raw rows, 354 eligible
rows, no withheld rows, zero consecutive failures, 25/25 recent successful
runs, and a resolved incident. It remains active and healthy.

## Alert behavior extended from #231

The scheduled audit keeps reporting the total recurring-source count, but the
`repeated-unconfirmed-identity-source` email is edge-triggered against a
durable sorted source-set baseline:

- the first successful run records the existing cohort without paging;
- a source first reaching three unresolved occurrences alerts once;
- a resolved source leaves the cohort and alerts if it later crosses again;
- a failed alert does not advance the baseline, so the next audit retries it;
- a failed baseline read never replaces the last durable cohort;
- structural failures, audit errors, and coverage regressions retain their
  existing failure and enforcement behavior.

The email remains aggregate-only and does not expose source IDs or role data.

## Remediation lanes

1. For current exact-provider application routes, trace each occurrence through
   provider, tenant, immutable posting ID, and the reviewed source checkpoint.
   Add only provider-scoped evidence that is collision-safe.
2. For retired or closed history, including Zapply, preserve provenance until
   the retention policy or an explicit reviewed retirement decision applies.
   Do not infer identity from an intermediary, search, or company-careers URL.
3. Prioritize the largest repeated employer families within each source, then
   rerun the bounded audit after each evidence rule. A falling backlog is
   progress; it is not proof of zero unresolved identities.
4. Keep every production repair at or below 120 changes, require the exact
   preview token and count, apply only after owner approval, and finish with a
   zero-change audit of the affected scope plus the full bounded audit.

## Acceptance gates for the extension

- An unchanged copy of the known seven-source cohort sends no recurrence email.
- A synthetic source newly crossing three occurrences sends the recurrence
  signal while the overall audit can remain passed.
- Failed alert delivery leaves the old cohort durable for retry.
- A source that resolves and later recurs alerts again.
- Structural or coverage regression still fails enforcement.
- The live #231 audit continues to expose the unresolved inventory until each
  source has grounded identity evidence or a reviewed lifecycle disposition.

This extension removes the false-positive pager behavior; it does not close
#231 or claim that the remaining 1,747 unconfirmed occurrences are resolved.
