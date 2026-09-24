# Company icons

Company icons are stored against `canonical_employers`, not provider mappings or a company website domain. The asset lives in the existing `DOCUMENTS` R2 bucket under `company-icons/<canonical-employer-id>/...`; the D1 `icon_key` is the only public reference.

## Operator workflow

For a reviewed square PNG, WebP, or SVG, use a canonical ID such as `acme` and an immutable filename such as `logo-v1.webp`. Upload the asset to the existing documents bucket, then attach that exact key while creating or updating the employer. The API rejects a key outside that employer's `company-icons/<id>/` prefix, and rejects a new employer without a key.

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
