# Serving coverage backfill handoff

This runbook is the operational handoff for publishing jobs that are already
stored but are hidden by posting-identity or catalog-admission gates. The code
and registry migration may be shipped independently. **Do not run any repair
until an owner approves the exact preview token and counts.**

## Starting point

The 2026-09-20 production snapshot contained:

- 5,806 open stored jobs
- 5,091 open technical jobs
- 4,384 technically relevant jobs admitted to the catalog
- 3,544 jobs served after the public posting-identity gate
- 840 admitted jobs hidden by posting identity
- 707 technical jobs blocked by admission: 231 application-form, 231
  aggregate-board, 162 blocked/uninspectable, 48 unresolved, and 35
  posting-detail

Treat these as a historical baseline, not as apply guards. Capture fresh
counts immediately before every production operation.

## Preconditions and stop gates

1. Merge and deploy the commit containing migration
   `0031_reviewed_source_employer_mappings.sql` to both production Workers.
   Confirm the intended versions are at 100% and the D1 migration is applied.
2. Run `npx wrangler whoami`, using the repository's approved Cloudflare
   credentials. Do not use bare `wrangler deploy`; follow
   [DEPLOYMENT.md](DEPLOYMENT.md) and [api-ingestion-split.md](api-ingestion-split.md).
3. Set the operator environment without committing secrets:

   ```bash
   export CATALOG_API_URL=https://intern-notifs.jdkrasnick.workers.dev
   export OPERATIONS_SHARED_SECRET='use-the-current-deployed-operations-secret'
   ```

4. Verify the protected deployment and admission-health endpoints before any
   preview. A `404` from a protected endpoint means the operations secret is
   absent, stale, or for a different environment: **stop**. Do not interpret it
   as an empty result.
5. Require healthy ingestion/admission queues, empty relevant DLQs, no active
   incident, and no concurrent repair. Archive every complete JSON preview in
   a private operator location outside Git.
6. Stop on conflicts, presentation disagreements, unresolved duplicate groups,
   changed snapshot digests, token/count drift, unexpected notification/outbox
   writes, or growing queue/DLQ depth.

## 1. Posting-identity repair

Install the exact lockfile dependencies, then take the paged, read-only audit:

```bash
npm ci
npm run audit:posting-identity
```

Archive the report. Review its gate facts, conflicts, presentation
disagreements, duplicate groups, coverage, and unknown URL families. A first
audit may report repairable legacy rows; that is not permission to apply. The
preview must still be internally consistent and free of non-repairable
blockers.

Repair identity and occurrences as separate manifests. For identity:

```bash
npm run migrate:posting-identity -- --scope identity

# Only after owner approval of this preview's exact three guards:
npm run migrate:posting-identity -- --scope identity --apply \
  --repair-token EXACT_TOKEN \
  --expected-changes EXACT_COUNT \
  --expected-duplicate-jobs EXACT_COUNT

npm run migrate:posting-identity -- --scope identity
```

The repeated preview must report zero remaining planned identity changes and
zero duplicate jobs. Then repeat the same preview, approve, apply, and verify
sequence with `--scope occurrences`, using that scope's independent token and
counts. Finish with:

```bash
npm run audit:posting-identity
```

Do not proceed unless the final gate passes and reports no remaining repair
drift.

## 2. Trusted-community admission repair

The trusted catalog policy covers these six source IDs:

- `vanshb03-summer-2027`
- `simplify-summer-2026`
- `speedyapply-2027-swe`
- `speedyapply-2027-ai`
- `northwestern-fintech-2027-quant`
- `canadian-tech-2027`

Keep each write bounded to one source. For every source, preview and archive:

```bash
npm run migrate:trusted-admission -- --source-ids SOURCE_ID
```

Require an empty conflict list and review the exact changed count. After owner
approval, apply only that preview:

```bash
npm run migrate:trusted-admission -- --source-ids SOURCE_ID --apply \
  --repair-token EXACT_TOKEN \
  --expected-changed EXACT_COUNT

npm run migrate:trusted-admission -- --source-ids SOURCE_ID
```

The repeated preview must report zero changes before moving to the next source.
This publishes eligible catalog entries only. Keep trusted-community alerts at
their existing opt-in setting; do not create notification or outbox work.

## 3. Official-source admission

Migration `0031` registers all reviewed Greenhouse and Ashby source scopes that
were not already covered by a more-specific canonical-employer decision. Its
admission configuration change should cause those sources to be regraded on
their next complete poll. Prefer that normal source cycle over a broad manual
historical backfill.

Wait for at least one complete Greenhouse and Ashby cadence, then require the
ingestion, destination-verification, and admission queues and DLQs to drain.
Verify affected checkpoints carry the new admission configuration version.

If a separate historical admission backfill is still needed, follow the
bounded `/internal/admission/backfill` procedure in [DEPLOYMENT.md](DEPLOYMENT.md):

1. Freeze one preview generation.
2. Enqueue pages no larger than 500, retaining the returned generation and
   cursor. Retry only an exact failed cursor with `retryQueued: true`.
3. Review completed evidence by source, host, employer, classification, and
   notification history.
4. Stage one source at a time in batches no larger than 120 records.
5. Obtain owner approval for each staged repair token and exact change count,
   apply it once, and re-preview before continuing.

Do not revive the retired Zapply source. Aggregate-board destinations remain
blocked by design, and unresolved or conflicting evidence remains a manual
review item.

## Verification and rollback

After each phase, capture the stored -> technical -> admitted -> identity-
confirmed -> publicly served funnel from D1 and compare it with a fresh public
catalog sample. Exercise both list and job-detail routes. Confirm that no push,
email, notification, or pending-outbox rows were created and that all relevant
DLQs remain empty.

If trusted-community results regress, disable trusted-community catalog
publication first. If an employer mapping is wrong, stop processing and
supersede it through the reviewed mapping workflow; do not delete audit history
or rewrite the deployed migration. Any rollback or follow-up repair requires a
new preview, token, exact count, and owner approval.
