<p align="center">
  <img src="mobile/assets/icon.png" alt="InternNotifs logo" width="144" />
</p>

<h1 align="center">InternNotifs</h1>

<p align="center">
  <strong>A calm, open-source radar for technical internships and early-career roles.</strong>
  <br />
  Find credible opportunities sooner and continue on the employer's official application form.
</p>

<p align="center">
  <a href="https://github.com/JDKrasnick/intern-notifs/actions/workflows/ci.yml"><img src="https://github.com/JDKrasnick/intern-notifs/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0E7490.svg" alt="MIT License" /></a>
  <a href="docs/product-roadmap.md"><img src="https://img.shields.io/badge/status-active%20development-2563EB.svg" alt="Project status: active development" /></a>
</p>

<p align="center">
  <a href="PRODUCT.md">Product brief</a>
  ·
  <a href="docs/product-roadmap.md">Roadmap</a>
  ·
  <a href="docs/DEPLOYMENT.md">Operations</a>
  ·
  <a href="https://jdkrasnick.github.io/intern-notifs/support.html">Support</a>
</p>

## Overview

InternNotifs is a free, mobile-first service for students navigating technical
internships, co-ops, apprenticeships, new-grad programs, and explicitly
entry-level roles. It monitors reviewed employer career systems and attributed
community sources, turns their listings into one consistent catalog, and makes
new opportunities easy to act on.

The product is designed for quick checks between classes—not another job board
or application CRM to maintain. Students can browse the public catalog,
configure device notifications, and receive personal alerts without creating
an account. Accounts are reserved for private information that needs to sync,
including saved applications, résumés, and reusable profile data.

> [!IMPORTANT]
> InternNotifs is under active development. Pre-release iOS builds are being
> evaluated through TestFlight while catalog coverage and the mobile experience
> continue to mature. See the [product roadmap](docs/product-roadmap.md) for the
> current state of each milestone.

## Core capabilities

| Capability | What InternNotifs provides |
| --- | --- |
| Discover | A normalized catalog of technical early-career roles from reviewed Greenhouse, Lever, Ashby, and community sources. |
| Evaluate | Clear location, compensation, education, work-authorization, provenance, and freshness context when available. |
| Get notified | Device-scoped push alerts with saved filters, quiet hours, durable delivery records, and duplicate-safe deep links. |
| Apply | A direct handoff to the employer's official application form, with the student retaining review and submission control. |
| Keep track | Optional saved roles, application state, résumé storage, and profile data behind a verified account. |

The initial audience includes domestic and international undergraduate and
graduate students pursuing software engineering, AI/ML, data,
infrastructure/cloud, security, quantitative, product, and technical design
roles. Browse also includes general engineering, discipline engineering, and hands-on technical pathways after the same admission and official-destination checks. Existing alert preferences stay on the original technical scope until a reader explicitly opts into the expanded engineering categories.

## Open source admission

InternNotifs does not use a closed, preferred, or prestige-based employer
roster. **Any company-controlled Greenhouse, Lever, or Ashby board can be
accepted for direct monitoring when it passes the same verification process.**
Company size, funding, brand recognition, and an existing relationship with
InternNotifs are not admission requirements.

| Verification stage | Requirement |
| --- | --- |
| Ownership | First-party evidence connects the exact ATS board or tenant to the company's official careers presence. |
| Destination | Listings lead to an employer-controlled or otherwise authorized application host. |
| Feed integrity | The board returns complete, structurally valid snapshots with safe and working application links. |
| Quality baseline | The source passes review and a quiet monitoring baseline before it can generate alerts. |
| Ongoing health | Incomplete or suspicious snapshots are rejected, and unhealthy sources can be quarantined without closing valid roles. |

Admission of a board does not mean every posting is published. Individual roles
must still fall within the project's technical early-career scope. To suggest a
company, [open a source request](https://github.com/JDKrasnick/intern-notifs/issues/new/choose)
with the company name, official careers page, and exact Greenhouse, Lever, or
Ashby board URL. The complete rules are published in the
[Source and Correction Policy](https://jdkrasnick.github.io/intern-notifs/source-policy.html).

## Product commitments

- **Useful, not noisy.** New and relevant opportunities should be obvious
  without turning internship search into a daily maintenance task.
- **Official application handoff.** InternNotifs does not submit a non-partner
  application or bypass employer verification on a student's behalf.
- **Browse first.** Public discovery and device alerts do not require an
  account; authentication appears only when a feature genuinely needs private,
  synchronized data.
- **Source transparency.** Every listing retains provenance and freshness
  context. InternNotifs does not republish full employer-authored job
  descriptions as its own content.
- **Privacy by design.** Collection and retention are bounded, tracking is not
  used, and account deletion has a private support path.
- **Open development.** The code, product decisions, roadmap, and operating
  policies are available for public review.

The full product direction and design principles live in
[`PRODUCT.md`](PRODUCT.md).

## Architecture

InternNotifs uses a queue-backed Cloudflare runtime and an Expo/React Native
client. The public catalog and account-free alert settings are scoped to an
installation; private records are scoped to the verified account that owns
them.

| Area | Implementation |
| --- | --- |
| Mobile client | Expo SDK 55 and React Native, with iOS as the first release target |
| API and authentication | Cloudflare Workers, verified email/password accounts, and opaque sessions |
| Catalog and private records | Cloudflare D1 |
| Documents | Private Cloudflare R2 objects behind authenticated routes |
| Ingestion and notifications | Cron Triggers, Queues with dead-letter queues, and Expo Push Service |
| Infrastructure | OpenTofu with the Cloudflare provider |

Operational details are documented in the
[`deployment runbook`](docs/DEPLOYMENT.md), with provider-specific boundaries in
the [`Greenhouse architecture reference`](docs/greenhouse/architecture.md).

## Repository structure

| Path | Purpose |
| --- | --- |
| [`mobile/`](mobile/) | Expo/React Native application, native projects, mobile tests, and release checks |
| [`cloudflare/`](cloudflare/) | Cloudflare Worker routes, authentication, D1 access, and scheduled work |
| [`src/`](src/) | Shared catalog, ingestion, notification, and operational modules |
| [`infra/cloudflare/`](infra/cloudflare/) | OpenTofu configuration for Cloudflare infrastructure |
| [`docs/`](docs/) | Product decisions, policies, architecture, deployment, and release documentation |
| [`test/`](test/) | Backend, integration, infrastructure, migration, and contract tests |

## Local development

### Prerequisites

- Node.js 22 or newer
- npm
- Xcode or Android Studio only when running a native simulator or device build
- OpenTofu and Cloudflare credentials only for infrastructure work

### Backend and shared services

```bash
git clone https://github.com/JDKrasnick/intern-notifs.git
cd intern-notifs
npm ci
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
```

`test:e2e` builds both Cloudflare Workers and runs them as separate services in
a local `workerd` process. It requires no Cloudflare account or credentials.

### Mobile client

```bash
cd mobile
npm ci
npx expo start
```

The mobile app requires the public environment variables documented in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#eas-environments). Use a physical iOS
or Android device to verify push delivery and notification deep links;
simulator checks cannot prove APNs or FCM delivery.

## Contributing

Contributions that improve catalog reliability, accessibility, source
transparency, privacy, documentation, or the focused mobile experience are
welcome.

Before starting a substantial change, open an
[issue](https://github.com/JDKrasnick/intern-notifs/issues) so the approach can
be aligned with the [product roadmap](docs/product-roadmap.md). Pull requests
should stay focused, include relevant tests, and keep lint, typechecking, and CI
green. Never commit credentials, private account data, employer application
data, or production exports.

## Trust, safety, and support

| Resource | Purpose |
| --- | --- |
| [Privacy Policy](https://jdkrasnick.github.io/intern-notifs/privacy.html) | Data collection, use, sharing, and user choices |
| [Terms of Use](https://jdkrasnick.github.io/intern-notifs/terms.html) | Service terms and user responsibilities |
| [Data Retention Policy](https://jdkrasnick.github.io/intern-notifs/retention.html) | Retention periods and deletion behavior |
| [Source and Correction Policy](https://jdkrasnick.github.io/intern-notifs/source-policy.html) | Source standards, attribution, corrections, and removals |
| [Support](https://jdkrasnick.github.io/intern-notifs/support.html) | Product support and private account-deletion requests |
| [Store disclosure worksheet](docs/store-disclosures.md) | Maintainer reference for App Store privacy answers |

Do not post passwords, account email addresses, résumé contents, or other
personal information in a public GitHub issue.

## License

InternNotifs source code is available under the [MIT License](LICENSE).
InternNotifs-created catalog metadata is available under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Employer-authored
text, third-party source material, logos, and trademarks are excluded.
