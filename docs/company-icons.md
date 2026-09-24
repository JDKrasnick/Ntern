# Company icons

Company icons are stored against `canonical_employers`, not provider mappings or a company website domain. The asset lives in the existing `DOCUMENTS` R2 bucket under `company-icons/<canonical-employer-id>/...`; the D1 `icon_key` is the only public reference.

Backfill existing canonical employers manually with a reviewed, square PNG, WebP, or SVG asset, then set that exact key through `PUT /internal/admission/employers`. Keep the original display name, mapping, and reviewer record. A new canonical employer submitted through the operations API must include an `iconKey` under its own `company-icons/<id>/` prefix; this prevents silently adding another unbranded company.

Do not derive branding from arbitrary websites or third-party favicon services. A website domain may be recorded later as provenance, but it is not needed to store, serve, or validate an icon.
