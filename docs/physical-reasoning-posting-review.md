# Physical Reasoning posting URL review

Reviewed on 2026-10-18 for the owner-requested posting identity addition.

- Exact page: <https://physicalreasoning.ai/join/software-engineering-intern/>.
- The live employer page returned the title “Software Engineering Intern” and
  identified the program as “Internship · Summer 2027 · SF / NYC / Canada / Remote”.
- The page embeds its application form through Tally. It exposes no immutable ATS
  posting ID, so the approval uses the existing `reviewed-canonical-url` evidence
  contract rather than treating the title slug as an immutable provider ID.
- Retrieved HTML SHA-256:
  `a04d233b05aceaaedb7d88cea6d515e5d7e22412113c322aec8b59754af434b7`.
- Approval reference: `physical-reasoning-software-engineering-intern-2026-10-18`.

Only this exact HTTPS host and posting path are approved. Existing URL
canonicalization removes tracking parameters and trailing slashes. Other paths,
subdomains, and posting-selecting query parameters do not inherit approval.
Destination availability and catalog admission checks continue to run separately.

This code addition does not update the existing production occurrence. Deployment
and re-evaluation of that occurrence are needed before its confirmed identity can
appear in the production catalog.
