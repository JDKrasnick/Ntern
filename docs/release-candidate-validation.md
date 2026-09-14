# #120 and #96 release-candidate validation record

Use one copy of this record per release-candidate commit. It is evidence for
the production catalog-admission rollout (#120) and the physical-device release
gate (#96); it does not authorize a deployment, a repair, or a TestFlight
submission. Keep completed records outside the repository when they include
operator output, account identifiers, device tokens, or other private data.

## Candidate identity

- Release-candidate commit:
- Mobile build number and EAS environment:
- API and ingestion Worker deployment IDs:
- Validation window (UTC):
- Owner approving the TestFlight build:

## Production deployment and admission baseline

Record this before a migration, infrastructure apply, historical backfill, or
repair. The coordinator must save and review the exact OpenTofu plan before
applying it; do not substitute a newly generated plan at apply time.

- [ ] `npx wrangler whoami` confirms the intended Cloudflare account.
- [ ] Remote D1 migration list is saved; pending migrations are reviewed and
  applied in their declared order before dependent Worker code.
- [ ] `npm run build:cloudflare` succeeds.
- [ ] OpenTofu R2 backend is initialized, and the saved plan changes only the
  intended Worker, Browser Rendering binding, queue/DLQ, and configuration.
- [ ] The owner/coordinator approves the exact saved plan; its apply reaches
  the intended Worker version at 100%.
- [ ] `/internal/admission/health`, the admission audit, and the
  posting-identity audit pass. Record queue/DLQ depth and age, leases,
  freshness coverage, active incidents, publication state, and outbox baseline.

## Guarded candidate repair

Do not copy a repair token into GitHub, this repository, screenshots, or a
chat transcript. It is one-use and is valid only for the precise staged
candidate set.

- Source / frozen generation:
- Stage time (UTC):
- Candidate job count:
- Candidate occurrence count:
- Repair token: recorded in the approved private operations record
- Owner approval reference and time (UTC):

- [ ] The owner explicitly approves this token and both exact counts.
- [ ] Apply uses that token and exact expected counts; the transaction reports
  zero verification mismatches and no new notification/outbox rows.
- [ ] A source-scoped restage reports zero changes.
- [ ] Public catalog, grouped/detail views, Saved/unavailable behavior, release
  data, and official handoff preserve job IDs, `firstSeenAt`, recency, source
  references, posting identities, receipts, and notification state.
- [ ] Queue and DLQ are empty or have a separately resolved, recorded cause;
  there are no unexpected stale-eligible or quarantined admission incidents.

## Three-client catalog acceptance

Test a representative eligible role, a saved role that becomes unavailable,
and a grouped result. For each client, record device/browser and OS/version,
appearance, accessibility text size, test time, and evidence location.

| Client | Browse/detail | Saved unavailable | Grouped results | Official handoff | Result/evidence |
| --- | --- | --- | --- | --- | --- |
| Physical iOS | | | | | |
| Physical Android | | | | | |
| Production web | | | | | |

For mobile, also complete the notification, account, and deletion cases in
[`testflight-checklist.md`](testflight-checklist.md). A simulator, an Expo
receipt, or a direct push does not replace physical-device delivery through the
production pipeline.

## Seven-day custom-route expiry observation

Use a real eligible custom-route role; do not create a production role solely
to satisfy this gate. Record only non-sensitive identifiers in the release
record and retain detailed operator evidence privately.

- Job ID / source / host:
- Last successful verification (UTC):
- Freshness deadline (UTC):
- Grace deadline (UTC):
- Failed recheck evidence and time (UTC):

- [ ] The failed recheck pauses alerts immediately.
- [ ] The role remains catalog-visible only until the recorded seventh-day
  deadline; retries do not extend that deadline.
- [ ] After the deadline, unresolved verification removes it from public
  catalog results and it is unavailable when opened from Saved/history.
- [ ] The official-handoff state is not misleading during the transition.

## #96 release decision

- [ ] Root backend and mobile release checks pass at the release-candidate
  commit.
- [ ] Physical notification permission, real Expo/APNs delivery and delayed
  receipt, notification tap lifecycle, authenticated account, and account
  deletion checks are complete with private evidence.
- [ ] No unexplained production errors, duplicate deliveries, queue/DLQ
  failures, or admission incidents occurred during the validation window.
- [ ] The owner records an explicit go/no-go decision before inviting beta
  testers. Keep #120 open until the seven-day observation is complete.
