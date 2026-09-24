# Product decisions and launch record

## Authentication: browse first

**Decision:** No account is required when the app opens. Anyone can browse the public technical early-career catalog and open an employer's official application immediately.

An account is requested only when a person chooses a feature that stores or personalizes private data:

- saved application tracking;
- push alerts and role filters;
- résumé and reusable application profile; or
- using that data on another device.

This is intentionally not an anonymous shared account. Private data is scoped to a verified Cloudflare-authenticated user once someone elects to create an account.

## Résumé tailoring subscription

- The role catalog, alerts, saved applications, technical résumé bank, diff review, and access to previously generated artifacts remain available without a paid subscription.
- Creating a new job-specific tailored review consumes one monthly allowance: Free has 2, Plus is $4.99/month for 25, and Pro is $9.99/month for 100. Compiling, revisiting, or downloading an existing review does not consume another allowance.
- Paid access is provider-neutral in the API but may only be granted from a server-verified purchase. The iOS client must use App Store in-app purchase and support restore purchases; it must not unlock a tier from client input alone.
- Product identifiers, transaction verification, App Store Server Notifications, purchase/restore UI, and customer-support tooling remain release blockers for paid upgrades. Until those land, every account safely resolves to Free unless an explicitly trusted server-side entitlement exists.

## Authentication roadmap

- **Now:** Cloudflare-backed email/password sign-up with email verification, used only after a user opts into private features.
- **Next (iPhone):** Sign in with Apple, integrated with the Cloudflare identity boundary. See `FRONTEND_DESIGN.md` for the product constraints.
- **Later:** Google sign-in through the same provider-neutral identity boundary.

Google sign-in should not be enabled by itself on iOS; when it is offered, Sign in with Apple must also be offered to satisfy Apple's equivalent-login policy. Apple and Google keys stay server-side and are never included in the Expo app.

Optional Gmail application detection is not Google sign-in. It is available only after an InternNotifs account is authenticated, requests Gmail read-only access for one mailbox, and does not change the Apple/Google login sequencing above. Message text is examined only during a short-lived Apply-triggered check, is bounded and processed deterministically, and is not retained.

## Trust and policy decisions

- InternNotifs is operated by JD Krasnick under Pennsylvania law and is intended for people age 18 and older.
- Signup records a separate 18+ attestation and acceptance of the current Terms and Privacy Policy versions without collecting date of birth.
- GitHub remains the public open-source support and listing-correction channel. Private account, résumé, privacy, deletion, and export requests use the published support email.
- Verified access, correction, export, and deletion requests target completion within 30 days. Source corrections target acknowledgment within two business days and resolution within seven business days; credible fraud, malware, privacy, impersonation, or applicant-safety concerns are hidden while reviewed.
- Account data remains until deletion; abandoned signups expire after 7 days, inactive anonymous installations after 12 months, delivery receipts after 90 days, and assistance metadata after 30 days.
- Source code uses the MIT License. InternNotifs-created catalog metadata allows reuse with attribution under CC BY 4.0, excluding employer text, third-party source content, logos, and trademarks.
- JD Krasnick approved the published policy text as written and confirmed `onlinestuff309@gmail.com` as the public support mailbox on 2026-08-26. The mailbox may be replaced later without changing the private-support boundary.
- Simplify's 2027 internship list is the only initial `trusted-community` source. Trust allows a validated source-reported role into browse without canonical-employer resolution; it never proves posting identity, creates aliases, or enables alerts by itself. Catalog exposure uses one default-off runtime gate, while later alert activation requires a reviewed source-policy version change and permanently suppresses the activation backlog.

## Store-launch checklist

### Product and release

- [ ] Test browse-first device alerts without an account, then separately test account creation, email verification, application tracking, résumé upload, sign-out, and account deletion on a physical iPhone.
- [ ] Test notification permission approval and denial, a real push alert, and its job deep link.
- [ ] Confirm the deployed catalog has enough current technical early-career roles and that every source link reaches the employer's official application.
- [x] Produce a fresh TestFlight build after the browse-first and trust-surface changes; build `1.0.0 (22)` was accepted by App Store Connect on 2026-08-26.
- [ ] Resolve all TestFlight feedback and crashes.

### Required App Store materials

- [ ] Publish a privacy-policy URL and a support/contact URL, then supply both through Expo release configuration and App Store Connect.
- [ ] Complete App Privacy answers accurately: account contact data, résumé/profile content, application tracking, and device notification token handling.
- [ ] Provide the 1024×1024 app icon, App Store screenshots, description, subtitle, keywords, category, age rating, and support URL.
- [ ] Set App Review contact information and clear reviewer notes. Explain that catalog browsing requires no account; provide a test account only if a reviewer needs to test private features.
- [ ] Complete export-compliance, pricing/availability, content-rights, and release settings in App Store Connect.

### Before pressing release

- [ ] Merge the release branch only after CI passes and the new TestFlight build is accepted.
- [ ] Submit the chosen build for App Review and respond to any review questions.
- [ ] Choose manual release for a final human check, or automatic release after approval.

## Not launch blockers

Sign in with Apple and Google sign-in are quality improvements, not prerequisites for this initial email-based release. If Google is added, Sign in with Apple becomes part of that same release.
