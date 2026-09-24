# Company icons

Company icons are stored against `canonical_employers`, not provider mappings or a company website domain. The asset lives in the existing `DOCUMENTS` R2 bucket under `company-icons/<canonical-employer-id>/...`; the D1 `icon_key` is the only public reference.

## Discovery preview

Use the preview command only after an operator has resolved and confirmed the employer's official domain. It is deliberately not a name-to-domain matcher: a wrong domain produces a convincing but wrong logo.

With `LOGO_DEV_PUBLISHABLE_KEY`, Logo.dev is the first candidate. With `BRANDFETCH_CLIENT_ID`, Brandfetch is the second candidate. The command then shows official-site candidates for manual comparison. It never uploads or changes D1:

```sh
npm run preview:employer-icon -- --company "Figma" --domain figma.com
```

Set the publishable key only in the local shell or CI secret; the command redacts it from the JSON review artifact:

```sh
read -s LOGO_DEV_PUBLISHABLE_KEY
export LOGO_DEV_PUBLISHABLE_KEY
read -s BRANDFETCH_CLIENT_ID
export BRANDFETCH_CLIENT_ID
npm run preview:employer-icon -- --company "Figma" --domain figma.com
unset LOGO_DEV_PUBLISHABLE_KEY
unset BRANDFETCH_CLIENT_ID
```

The result places Logo.dev first, Brandfetch second, then ranks Organization JSON-LD above Open Graph, Apple touch, and favicon candidates. It also makes a bounded `HEAD` request for each candidate and rejects unsupported image types, failed responses, and assets larger than 1.5 MB before review. PNG, WebP, SVG, AVIF, and JPEG are valid review candidates; approved JPEG/AVIF candidates must be converted to WebP before upload.

Every result remains review-only: compare the provider candidates against the official site and verify that the mark identifies the employer. Brandfetch's standard Logo API terms require hotlinking, so its candidate is evidence for review and must not be copied into R2 unless a separate self-hosting agreement permits it. Confirm Logo.dev's plan permits the intended R2 retention before copying a Logo.dev result.

If the website is challenge-gated or returns non-HTML, the command returns an empty candidate set with `blockedReason`. Record that outcome and continue to the ATS-board or manual-review rung; never substitute an ATS provider's own logo.

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

Do not derive branding from arbitrary websites or third-party favicon services. A website domain may be recorded later as provenance, but it is not needed to store, serve, or validate an icon.
