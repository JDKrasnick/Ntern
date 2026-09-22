# App Store and Google Play disclosure worksheet

Prepared for issue #41 from the mobile and Cloudflare production data flows in
TestFlight build `1.0.0 (22)`, built from commit `a838fa4`. Re-audit before
submission if the selected release adds an SDK, login provider, permission,
analytics, advertising, payment, or new profile field.

This is an owner-entry worksheet, not proof that the answers have been
published in App Store Connect or Play Console.

## Shared facts

- The app collects data: **Yes**.
- Data is sold: **No**.
- Data is used for cross-company tracking or advertising: **No**.
- Data is shared with third parties for their own purposes: **No**. Cloudflare,
  Google, Resend, Expo, APNs, and FCM act as service providers for hosting,
  optional Gmail read-only access, email, and requested push delivery.
- Data is encrypted in transit: **Yes**.
- Account creation is optional; public browsing and installation-scoped alerts
  work without an account.
- Account deletion is available in the app and through the public support page.
- The public privacy-choices/account-deletion URL is
  `https://jdkrasnick.github.io/intern-notifs/support.html#delete-account`.
- The privacy-policy URL is
  `https://jdkrasnick.github.io/intern-notifs/privacy.html`.

Apple defines collection as off-device transmission retained beyond real-time
request handling and requires disclosure of integrated partners' practices.
Google similarly requires disclosure of data transmitted off device, including
data sent by libraries and SDKs. Sources:

- [Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
- [Apple privacy manifest data-use documentation](https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests)
- [Google Play Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Google Play account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)

## Audited collection map

| Data | Feature/purpose | Identity relationship | Required? | Retention |
| --- | --- | --- | --- | --- |
| Email, password-derived hash/salt, consent versions | Account creation, verification, security | Account-linked | Optional to use app; required for account | Until deletion; abandoned unverified signup 7 days |
| Name, profile email, phone, location, education, work authorization, links, reusable answers | Optional application profile and form assistance | Account-linked | Optional | Until deletion |
| Résumé/documents, Resume Tuner bank entries, saved bases, pasted job descriptions, review drafts, application status, notes, masked assistance field plan | Optional application tracking and assistance | Account-linked | Optional | Documents and Resume Tuner records until deletion; assistance metadata 30 days |
| Connected Gmail address, encrypted OAuth credential, sender, subject, date, labels, keyed message identifier, transient bounded message text, and derived match evidence | Optional Gmail application detection | Account-linked | Optional | Credential/sync state while connected; message text is not retained; pending evidence 30 days; keyed deduplication value 180 days; all deleted on disconnect/account deletion |
| Random account/user ID | Authentication and private-data isolation | Account-linked | Optional | Until deletion |
| Random installation ID, Expo push token, platform | Account-free settings and requested alert delivery | Deliberately not connected to account identity | Installation ID required; push token optional | 12 months inactive; invalid tokens disabled earlier |
| Alert filters, quiet hours, wording, last catalog open, delivery receipts | Personalization, new-role inbox, reliable delivery | Installation-linked | Optional except the empty default settings record | Installation 12 months inactive; receipts 90 days |
| Search terms in short-lived request logs | Search request handling and service security | Not intentionally linked to account | Optional | Cloudflare logs no more than 7 days |
| Request/error/performance metadata and pseudonymous rate-limit keys | Reliability, abuse prevention, security | Not intentionally linked in product storage | Required to operate service | Logs no more than 7 days; rate-limit keys up to 7 days after window/block |
| Support email or public issue content | Support, privacy rights, and corrections | Linked when the requester identifies themselves | Optional | Private request plus up to 12 months; public project history subject to moderation |

The app does **not** request contacts, precise device location, photos, camera,
microphone, health data, payment information, or the advertising identifier. It
does not collect an employer site's browsing history after handoff.
Gmail message text is processed transiently during an Apply-triggered check and
is not retained. Attachments are not processed, and raw headers and raw Gmail
message IDs are not retained. Gmail evidence is matched deterministically and
is not used for AI, model training, advertising, or unrelated analytics.

## Apple App Privacy answers

In App Store Connect, answer **Yes, we collect data from this app**, then use
the following conservative entries. All listed types are **not used for
tracking** and **not used for third-party or developer advertising**.

| Apple data type | Linked to identity | Purpose |
| --- | --- | --- |
| Contact Info → Name | Yes | App Functionality |
| Contact Info → Email Address | Yes | App Functionality |
| Contact Info → Phone Number | Yes | App Functionality |
| Location → Coarse Location | Yes | App Functionality |
| Sensitive Info | Yes | App Functionality |
| User Content → Other User Content | Yes | App Functionality |
| User Content → Emails or Text Messages | Yes | App Functionality; optional Gmail sender/subject/date/labels and bounded message text for confirmation detection; message text is not retained |
| Identifiers → User ID | Yes | App Functionality |
| Identifiers → Device ID | No | App Functionality |
| Usage Data → Product Interaction | Yes | App Functionality; Product Personalization |
| Search History | No | App Functionality |
| Diagnostics → Performance Data | No | App Functionality |
| Diagnostics → Other Diagnostic Data | No | App Functionality |

Use these URLs:

- Privacy Policy URL: `https://jdkrasnick.github.io/intern-notifs/privacy.html`
- User Privacy Choices URL: `https://jdkrasnick.github.io/intern-notifs/support.html#delete-account`

The checked-in `mobile/ios/InternNotifs/PrivacyInfo.xcprivacy` mirrors these
categories. Generate Xcode's privacy report from the final archive and compare
it with this table before publishing the App Privacy answers.

## Google Play Data safety answers

### Top-level answers

- Does the app collect or share required user data types? **Collects data; does
  not share data with third parties for their own purposes.**
- Is all transmitted user data encrypted in transit? **Yes.**
- Can users request account and associated-data deletion? **Yes.**
- Account deletion web resource:
  `https://jdkrasnick.github.io/intern-notifs/support.html#delete-account`
- Has the app received an independent security review that qualifies for the
  Play badge? **No**, unless a qualifying review is completed later.

### Collected data types

| Google category/type | Optional or required | Purpose |
| --- | --- | --- |
| Location → Approximate location | Optional | App functionality; personalization |
| Personal info → Name | Optional | App functionality |
| Personal info → Email address | Optional | Account management; app functionality; security |
| Personal info → User IDs | Account ID optional; anonymous installation ID required | Account management; app functionality; security |
| Personal info → Address | Optional | App functionality |
| Personal info → Phone number | Optional | App functionality |
| Personal info → Other info | Optional | App functionality; includes education, work authorization, links, and reusable answers |
| App activity → App interactions | Optional | App functionality; personalization |
| App activity → In-app search history | Optional | App functionality |
| App activity → Other user-generated content | Optional | App functionality; application statuses, notes, and answers |
| Messages → Emails | Optional | App functionality; Gmail sender/subject/date/labels and bounded message text for confirmation detection; message text is not retained |
| Files and docs → Files and docs | Optional | App functionality; résumé/document storage |
| Device or other IDs → Device or other IDs | Installation ID required; push token optional | App functionality; security; requested notifications |
| App info and performance → Other app performance data | Required | App functionality; diagnostics; security |

For every row: select **collected**, **not shared**, **not processed for
advertising**, and the purposes above. Mark optional profile, account, alert,
and document fields optional because every user can browse without providing
them. The random installation identifier and basic service diagnostics are the
required data paths.

## Google API Limited Use and restricted-scope gate

- Request only `https://www.googleapis.com/auth/gmail.readonly`.
- During an active Apply window, the initial scan paginates Inbox messages back
  to the click boundary and incremental sync uses Gmail history. The matcher
  extracts bounded text transiently and does not store or log it.
- Require existing metadata-scope users to disconnect and reconnect before
  running content-aware checks so Google presents the expanded consent grant.
- Use and transfer of Google user data must comply with the Google API Services
  User Data Policy, including Limited Use.
- Keep `GMAIL_ENABLED=false` for general users until Google restricted-scope
  verification and the required annual third-party security assessment are
  complete. Before then, use only OAuth-console test users.
- Reconcile these additions in App Store Connect and Play Console before any
  build exposing Gmail detection is submitted for review.

## Final submission reconciliation

### Operational verification (2026-08-26)

- TestFlight build `1.0.0 (22)` was uploaded to and accepted by App Store
  Connect.
- The Privacy Policy, Terms, Data Retention, Source and Correction Policy,
  Support, and public account-deletion URLs returned `200` without a login.
- D1 migration `0005_auth_consent.sql` was applied to production and the
  production Worker version `29e40ce2-bab7-4276-b196-41d1116d808d` was
  promoted after a successful 10% canary.
- JD Krasnick approved the published policy text as written and confirmed
  `onlinestuff309@gmail.com` as the public support mailbox.
- These checks do not constitute publication of store-console answers, final
  archive reconciliation, or physical-device acceptance.

Before the owner publishes either store form:

1. Build the exact release commit and generate the iOS privacy report.
2. Re-run `npm run release:check` in the EAS production environment.
3. Confirm all policy and deletion URLs return `200` over HTTPS without login.
4. Compare the final dependency lockfile and native permissions with this
   worksheet.
5. Publish the store answers, record the date and release commit below, and
   rerun physical-device account deletion.

- Published by: _pending owner entry_
- Published on: _pending owner entry_
- Release commit/build: _pending owner entry_
