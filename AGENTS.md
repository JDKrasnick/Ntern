# InternNotifs project memory

## Product in one sentence

InternNotifs is a lightweight, simple mobile early-career radar: it notifies students when credible technical roles appear and gets them quickly to the employer's official application form.

## Product direction

- Initial audience: international and domestic undergraduate/graduate students.
- Initial scope: technical internships, co-ops, apprenticeships, new-grad programs, and explicitly entry-level roles (software engineering, AI/ML, data, infrastructure/cloud, security, quantitative, product, and technical design).
- Browse first: the public catalog, device notification settings, and personal push alerts require no account. Ask for an account only to sync saved applications or store a résumé/profile.
- Applications are always handed off to the employer's official form. Do not automate submission without an authorized partner integration.
- The experience should remain free, calm, privacy-respecting, open-source-friendly, and **simple and clean**. One clear primary action per screen; prefer native mobile controls and plain language.
- Authentication today is email/password plus verification. Sign in with Apple is the next iPhone improvement; Google sign-in is deferred and must ship alongside Sign in with Apple on iOS.

The detailed product tracker is [`docs/product-roadmap.md`](docs/product-roadmap.md). Keep its milestone statuses and checkboxes current when work lands.

## Architecture references

- Greenhouse monitoring deployment boundaries, queue flow, cadence, retries,
  shadow behavior, and rendered diagram:
  [`docs/greenhouse/architecture.md`](docs/greenhouse/architecture.md).

## Owner preferences

- Repository: `JDKrasnick/intern-notifs`; owner GitHub handle: `JDKrasnick`.
- Make small, atomic or medium-sized commits and keep CI green. Preserve unrelated dirty working-tree changes.
- Operate the active backend through the configured Cloudflare account; validate access with `npx wrangler whoami` before Cloudflare operations. AWS is retained rollback/export infrastructure only: do not access, deploy, or modify it unless the owner explicitly requests a legacy export or recovery.
- The owner handles Apple/App Store Connect UI and physical-device testing when required. Agents can launch EAS builds and submissions after approval.
- After using the iPhone Simulator, shut down any booted simulator and quit the Simulator app before finishing unless the owner asks to leave it running; it consumes significant memory.

## Read before release work

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): infrastructure, EAS/TestFlight, release commands, and operational identifiers.
- [`docs/testflight-checklist.md`](docs/testflight-checklist.md): physical-device acceptance checklist.
- [`docs/PRODUCT_DECISIONS.md`](docs/PRODUCT_DECISIONS.md): authentication and App Store launch decisions.
- [`docs/FRONTEND_DESIGN.md`](docs/FRONTEND_DESIGN.md): frontend principles and Sign in with Apple design constraints.

## Security boundary

Do not put passwords, Cloudflare API tokens, AWS credentials, Apple private keys, App Store Connect API keys, personal email addresses, or Expo tokens in Git, documentation, or mobile `EXPO_PUBLIC_*` variables. The IDs and URLs declared public below are configuration identifiers, not secrets.
