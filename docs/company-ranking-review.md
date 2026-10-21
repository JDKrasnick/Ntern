# Catalog-wide company review

Company tiers express an editorial judgement about career reputation and
business substance for technical early-career candidates. They are not a
measured prestige index or a promise about an individual team.

The review considers engineering and research reputation, recognizable products,
customers and operating history, financial backing, learning opportunities, and
available compensation evidence. Public LinkedIn presence can corroborate an
employer's footprint. Followers alone do not determine its tier. Missing pay or
follower counts are recorded as missing, not estimated or treated as a penalty.

The existing tiers remain Exceptional, Strong, Established, and neutral
Unrated. A reviewed neutral assessment means available evidence did not justify
an uplift. It is distinct from an employer that still awaits review. Small
specialist firms can earn a strong tier from substantive technical work.

Individual assessments are recorded in
`scripts/data/company-ranking-holistic-reviews.jsonl`, including evidence URLs,
review date, rationale and confidence. Older explicit reviews remain in
`scripts/company-ranking-seeds.ts`. An individual assessment takes precedence
over that older roster. Review aliases only when employer identity is established;
similarly named firms and a parent company do not automatically inherit a tier.

Run the read-only coverage audit against the private inventory exported from the
employer registry and catalog:

```sh
npx tsx scripts/audit-company-ranking-coverage.ts --require-complete
```

The audit writes the full missing-company list to
`.context/holistic-ranking-coverage.json` and fails the completeness gate while
any inventory company lacks a review. This ongoing review is not complete and
has not been published merely because the file passes schema validation.

Apply reviewed batches through the operations API after migration 0060 and
the corresponding Worker release. The importer preserves reviewed rows,
validates every proposal before writing, and re-reads all applied records to
verify durable tier, rationale, sources and aliases:

```sh
npx tsx scripts/apply-company-ranking-reviews.ts --api https://api.ntern.app --catalog
npx tsx scripts/apply-company-ranking-reviews.ts --api https://api.ntern.app --catalog --apply
```

The importer includes the existing seed roster; individual reviews take
precedence. Its canonical employer updates and separate catalog name updates
never create employer identities. A batch receipt is not proof of complete
coverage: refresh the inventory and compare it against both persisted registries
before declaring the catalog-wide review complete.
