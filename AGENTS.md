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
- Cloudflare deployment, secrets, cutover, and rollback:
  [`docs/cloudflare-migration.md`](docs/cloudflare-migration.md) and
  [`docs/api-ingestion-split.md`](docs/api-ingestion-split.md).
- Source operations (pause, resume, replay, recover, quarantine) run through
  the Worker operations API with the `X-Operations-Key` secret. `recover`
  forces one validation and leaves the source paused, so `resume` follows a
  healthy run.

## Owner preferences

- Repository: `JDKrasnick/intern-notifs`; owner GitHub handle: `JDKrasnick`.
- Make small, atomic or medium-sized commits and keep CI green. Preserve unrelated dirty working-tree changes.
- Production runs on Cloudflare, not AWS: Workers `intern-notifs-ingestion`
  and `intern-notifs`, backed by D1, R2, and Cloudflare Queues. Validate access
  with `npx wrangler whoami` before Cloudflare operations. Deploy code with
  `npm run build:cloudflare`, then OpenTofu (`tofu -chdir=infra/cloudflare plan`
  and `apply`); state lives in the R2 bucket `intern-notifs-opentofu-state` and
  local credentials live in an untracked `.env`. AWS is rollback/export
  infrastructure only: do not access, deploy, or modify it unless the owner
  explicitly requests legacy export or recovery.
- The owner handles Apple/App Store Connect UI and physical-device testing when required. Agents can launch EAS builds and submissions after approval.
- After using the iPhone Simulator, shut down any booted simulator and quit the Simulator app before finishing unless the owner asks to leave it running; it consumes significant memory.

## Read before release work

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): EAS/TestFlight, release commands, and operational identifiers. Its AWS/CDK infrastructure sections are historical; production runs on Cloudflare.
- [`docs/testflight-checklist.md`](docs/testflight-checklist.md): physical-device acceptance checklist.
- [`docs/PRODUCT_DECISIONS.md`](docs/PRODUCT_DECISIONS.md): authentication and App Store launch decisions.
- [`docs/FRONTEND_DESIGN.md`](docs/FRONTEND_DESIGN.md): frontend principles and Sign in with Apple design constraints.

## Security boundary

Do not put passwords, Cloudflare API tokens, AWS credentials, Apple private keys, App Store Connect API keys, personal email addresses, or Expo tokens in Git, documentation, or mobile `EXPO_PUBLIC_*` variables. The IDs and URLs declared public below are configuration identifiers, not secrets.
