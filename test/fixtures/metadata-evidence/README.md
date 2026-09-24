# Metadata evidence payloads

Recorded employer responses that the metadata collection path parses. Each file
is a **sanitized** capture of a real, publicly readable response, not a whole
live posting: only the fields the acquirer and extractor read are kept, the
application URL is stored without query parameters, and `content` is reduced to
the disclosure section the assertions depend on.

| File | Source | Captured | Kept |
| --- | --- | --- | --- |
| `greenhouse-figma-6178851004.json` | `boards-api.greenhouse.io/v1/boards/figma/jobs/6178851004?pay_transparency=true&pay_input_ranges=true` | 2026-09-24 | `id`, `title`, `location`, `first_published`, `updated_at`, `pay_input_ranges`, and the pay-transparency section of `content` |

These files exist so a test can drive the real extraction path without a
network call. `test/e2e/role-metadata-write-reduction.e2e.mjs` serves them to the
compiled ingestion Worker; prefer re-recording a sanitized capture over
hand-editing a payload, so the parser keeps seeing real employer shapes.

## Live verification

The same suite can read the employer's API over the network instead of the
capture (read-only GETs, no credentials):

```
ROLE_METADATA_LIVE=1 node --test test/e2e/role-metadata-write-reduction.e2e.mjs
```

To drive the whole path through the local Cloudflare dev server instead — HTTP
collection, local queue consumer, real provider response, local D1 — apply the
migrations, seed the role, and collect:

```
npx wrangler d1 migrations apply intern-notifs-dev-db --local --config wrangler.dev.ingestion.jsonc --persist-to .wrangler/e2e-live
npx wrangler d1 execute intern-notifs-dev-db --local --config wrangler.dev.ingestion.jsonc --persist-to .wrangler/e2e-live --file seed.sql
npx wrangler dev --config wrangler.dev.ingestion.jsonc --port 8791 --persist-to .wrangler/e2e-live \
  --compatibility-date 2026-08-27 --var INTERNAL_SERVICE_SECRET:... --var OPERATIONS_SHARED_SECRET:...
curl -X POST http://127.0.0.1:8791/internal/role-metadata/backfill \
  -H 'X-InternNotifs-Service-Key: ...' -H 'X-Operations-Key: ...' \
  -H 'Content-Type: application/json' -d '{"action":"collect","limit":10}'
```

`--compatibility-date 2026-08-27` is required because the workerd binary in
`package-lock.json` is older than the dev config's date. The dev consumer
delivers on the destination queue's `max_batch_timeout` (60s), so allow a minute
before reading `role_metadata_evidence`. Inspect the result with
`npx wrangler d1 execute ... --local --command "SELECT ..."`.
