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
any inventory company lacks a review. File validation alone does not establish
production publication; compare the proposals with both persisted registries.

## Completed snapshot: October 21, 2026

The refreshed inventory at 19:16 UTC contains **1,600 normalized company
identities**, combining the employer registry, open admitted database roles,
and a full public-catalog snapshot pinned at 19:13 UTC. All have assessments:
1,417 identities use individual reviews and 183 use the existing reviewed roster.
The JSONL retains 1,423 individual review records, including companies outside
this current snapshot. A final database inventory read found no newly introduced
company labels.

| Reviewed tier | Company identities |
|---|---:|
| Exceptional | 19 |
| Strong | 536 |
| Established | 1,003 |
| Unrated, reviewed neutral | 42 |
| Missing review | 0 |

Production verification completed at 19:26 UTC. All **1,086 canonical employer
records** are reviewed. Another **576 current catalog-only keys** have durable
reviews in the separate catalog registry; that registry retains 600 records
including labels outside this snapshot. Several canonical records normalize to
the same company key, so record counts and unique-identity counts differ.

The final publication applies 252 canonical reviews and 135 catalog-only
reviews, preserves existing reviewed records, and independently re-reads every
write. A second application makes zero updates. The shipped ranking store
resolves all **4,297 public catalog groups** against persisted assessments:
4,266 receive a rated company component and 31 receive reviewed-neutral 50.
There are no unmapped groups or conflicting name scores in this snapshot.
Live sample scores match the scorer; the first 50 Last day results remain in
descending Best order. Web checks retain Last day + Best and hidden scores.
No admission, notification eligibility, native layout, or scoring-weight change
is part of this data publication.

Evidence and the operator-facing export live in the workspace's ignored context:

- `.context/holistic-ranking-final-verification.json`
- `.context/holistic-ranking-final-production-apply.json`
- `.context/holistic-ranking-final-idempotence.json`
- `.context/company-rankings-reviewed.csv`

These are editorial assessments, not an exhaustive collection of every signal.
Only observed follower counts and role-specific compensation are retained;
missing values remain unknown. New companies introduced after the audited
snapshot still require admission review and otherwise stay neutral.

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
