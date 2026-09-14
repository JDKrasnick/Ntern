# TestFlight release checklist

For the release-candidate evidence record, including the #120 admission
rollout prerequisites and the #96 go/no-go decision, use
[`release-candidate-validation.md`](release-candidate-validation.md). Keep
repair tokens, device tokens, and account identifiers in the private operations
record rather than this repository.

Run this from `mobile/` using the intended EAS environment:

```bash
npx eas-cli@latest env:exec production 'npm run release:check'
npx eas-cli@latest build --platform ios --profile testflight --auto-submit
```

Before inviting testers:

- Confirm all six public EAS variables are present in the selected environment: Cloudflare API, Privacy Policy, Terms, Data Retention, Source/Correction Policy, and Support URLs.
- Run the root backend checks: `npm run lint && npm run typecheck && npm test`.
- Install the TestFlight build on two physical-device installations. Approve notifications on one and deny them on the other; no account should be required for either path.
- Confirm the approved installation registers an Expo token, receives a real push, and opens the corresponding job when the notification is tapped. Confirm denied permission has a clear in-app explanation.
- Confirm the deployed D1 aggregates show at least one anonymous installation, one completed alert preference, one active device, and one delivery receipt before replaying any pre-registration notification markers.
- On physical iOS and Android, tap an open-role alert while the app is foregrounded, backgrounded, and terminated; each tap must open one in-app role sheet with working Back behavior.
- Repeat with a role closed after delivery, then with an invalid job ID. Confirm the closed sheet has no Apply action, only shows a validated official-listing link, and the invalid ID shows the unavailable state.
- Open `internnotifs://jobs/<encoded-job-id>` directly. Confirm retry behavior, duplicate tap protection, source/corroboration and freshness labels, matched-filter wording, guest 72-hour New badges, and VoiceOver/TalkBack output.
- Change include/exclude filters, templates, and role abbreviations; trigger a matching and a non-matching job to confirm delivery behavior.
- Open Privacy Policy, Terms, Data Retention, Sources and corrections, and Support in Profile. Verify every HTTPS page is public and readable without sign-in.
- Create an account only after checking both the 18+ and policy acknowledgments. Verify the unchecked state cannot submit signup.
- Verify account deletion removes the signed-in user’s profile, applications, assistance records, documents, Cloudflare sessions, and sign-in identity while leaving device alerts and app settings intact.
- Reconcile the final archive and native privacy report against [`store-disclosures.md`](store-disclosures.md), then record the published Apple/Google answers and release build in that worksheet.
- Inspect the installed icon, launch splash, app version, and auto-incremented build number in TestFlight.
