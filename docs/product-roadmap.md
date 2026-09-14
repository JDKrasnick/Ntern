# InternNotifs product tracker

## Product direction

**Promise:** a calm, mobile-first early-career radar that tells students about credible technical roles quickly and gets them to the official application form with minimal friction.

**Initial audience:** international and domestic undergraduate/graduate students.

**Initial scope:** technical internships, co-ops, apprenticeships, new-grad programs, and explicitly entry-level roles — software engineering, AI/ML, data, infrastructure/cloud, security, quantitative roles, product, and technical design.

**Product constraints:**

- Public browsing and device-scoped push alerts; account only for synced applications and profile.
- Prefer official employer career sources and openly maintained, attributed public lists.
- Never automate a non-partner submission; users review and submit official forms themselves.
- Core experience remains free, simple, privacy-respecting, and suitable for open-source development.

## Milestones

| Milestone | Status | Exit criteria |
| --- | --- | --- |
| Catalog definition | In progress | Continuous employer discovery, source rules, taxonomy, and reliability targets operate without an owner-selected roster |
| Official source adapters | In progress | SQS-backed Greenhouse, Lever, and Ashby runtimes poll reviewed boards; Ashby is collecting production shadow evidence before per-board promotion, while SmartRecruiters remains planned |
| Catalog operations | In progress | Standardized ingestion, shared source-quality gates, durable source health, private live dashboard, source-candidate review queue, and bounded Firecrawl research workflow operate |
| Verified employer channel (#113) | In progress | D1 trust/publishing controls, web employer workspace, reviewed registry, provenance, direct submissions, reports, and operator queues are implemented behind a disabled rollout flag; production migration, dashboard enablement, and pilot remain |
| Mobile discovery MVP | In progress | Filtered feed, native deep-link alerts, official-form handoff, and tracker are polished |
| Gmail application detection | In progress | Test-user OAuth flow detects catalog confirmations reliably; Google restricted-scope verification, annual security assessment, closed-beta validation, and store disclosures are complete before general availability |
| Human-reviewed application assistance | In progress | Headed pilot fills a supported official form, pauses for unknowns and verification, and leaves final submission to the user |
| Headless application preparation | Planned | Isolated runner reuses proven mappings, supports live user handoff, and never bypasses verification or non-partner submission controls |
| Trust and release readiness | In progress | Approved public policies and support routes are live, and the disclosure worksheet, consent, retention enforcement, and release checks are deployed; store-console entry, final archive reconciliation, and physical-device acceptance remain |
| Cloudflare platform migration | In progress | Cloudflare infrastructure is live, the source backfill and grouped D1 projection are verified, the production mobile environment targets the Worker, and retained AWS rollback data is preserved |
| Closed beta | Planned | 30–50 student test cohort and agreed success metrics |
| Public release | Planned | TestFlight/Play validation complete and catalog reliability meets target |

## Immediate backlog

### Codex

- [x] Implement the Cloudflare replacement substrate with Workers, D1, R2, Queues, Cron Triggers, provider v5 Terraform, Cloudflare-native mobile authentication, and local end-to-end smoke coverage.
- [x] Provision the Cloudflare account, apply remote D1 migrations and Worker secrets, verify the source backfill, and cut the production mobile environment over with an AWS rollback window.
- [x] Bound sparse grouped-catalog filter scans, reconcile legacy notification markers through durable Expo receipts, isolate iOS plain-text accessibility state from secure authentication fields, and make account switching/sign-out race-safe with server-side session revocation.
- [x] Roll every configured GitHub board to its live 2027 repository contract, preserve source health across HTTP 304 responses, roll expired list-wide seasons forward, and defer or guardedly recover notification markers when no opted-in device exists.
- [x] Move push tokens, alert filters, and notification wording to an anonymous installation identity so signing in, signing out, and account deletion do not control device notifications.
- [ ] Export any recoverable AWS development data after the suspended account is reactivated; do not block the source-backed development cutover on that export.

- [ ] Continuously discover and verify the broadest practical employer set, then prioritize active sources by technical early-career relevance and international/student-friendly coverage.
- [x] Implement issue #113's staged verified-employer channel behind `EMPLOYER_PORTAL_ENABLED`, including organization roles, domain challenges and human review, immutable audits, D1-reviewed source registry, metadata proposals, direct submissions, public employer provenance, reports, quarantine/revocation, and explicit automatic-publishing enablement.
- [x] Land #107's bounded JSON-LD, job-sitemap, and explicit embedded-payload connector with reviewed D1 admission, shadow polling, complete-snapshot reconciliation, public-host enforcement, and `official-structured` provenance; the measured employer pilot remains part of the #113 rollout.
- [ ] Finish #56's shared statement-level work-authorization classifier, retained evidence reason, student filters, and alert matching; #113 supplies the provider-neutral status model and honest `unknown` default without inferring eligibility.
- [ ] Roll out #113 in order: apply the D1 migration and seed/verify registry parity, enable operator queues, pilot one manually approved employer, then consider the portal flag and automatic publishing only after its documented threshold.
- [x] Define source-admission, attribution, removal, and source-quality policies.
- [ ] Roll out trusted-community catalog admission for the legacy-ID Simplify source.
  - [x] Add provider-neutral trust policy, source-reported admission, durable two-snapshot alert qualification, atomic delayed promotion, a default-off catalog gate, circuit breakers, sanitized metrics, and the checked-in 2026-09-04 dry-run report.
  - [x] Keep standard-source admission repairs silent, revoke absent/closed trusted occurrences during bounded rollback, and reconcile validated trusted reappearances without overriding official closures.
  - [x] Repair provider-neutral single-posting/navigation classification and truncated-page browser recovery; [audit every eligible URL over HTTP](trusted-community/2026-09-05-destination-audit.md) without employer-specific exceptions. Rendered-page acceptance remains below.
  - [ ] Inspect all 646 browser-candidate routes and every failure class, then obtain owner approval before enabling `TRUSTED_COMMUNITY_CATALOG_ENABLED` and establishing the quiet baseline.
  - [ ] Observe one complete healthy snapshot, activate `exact-identity-or-two-complete-snapshots` through a reviewed source-policy version change, and complete the post-activation catalog/identity/index/outbox audit.
- [ ] Complete issue #120's catalog-admission rollout.
  - [x] Add the provider-neutral employer, posting-attribution, destination, and metadata admission record; derive canonical eligibility from source occurrences; and gate catalog indexes and alert outbox writes.
  - [x] Add reviewed D1 employer mappings and destination rules, browser-verification queue/DLQ processing, evidence and incident history, grouped support email states, guarded silent repair, and the Saved unavailable state.
  - [x] Add authoritative closure/`validThrough` detection, seven-day evidence scheduling and grace, tenant-safe Markdown continuations, frozen candidate-only backfills, source-scoped guarded staging, and unified admission health/audit reporting.
  - [ ] Bootstrap and import the production OpenTofu R2 backend, apply only migration `0012_destination_verification_schedule.sql`, configure the Browser Rendering and Resend bindings, and verify queue/DLQ health plus the admission and posting-identity audits in production.
  - [ ] Review the production candidate set, approve the exact guarded repair token/count, apply it, and verify unchanged job IDs, first-seen timestamps, recency, source references, and notification state.
  - [ ] Verify browse, detail, Saved/unavailable behavior, grouped results, and official handoff on physical iOS, physical Android, and production web, then observe a real seven-day custom-route grace transition before closing #120.
- [x] Add internal source-aware filtering (FAANG, verified startups/YC, normal, U.S.-citizenship requirement, advanced-degree requirement, and open/closed status) to catalog ingestion, alerts, and mobile discovery.
- [x] Add the signed-in “new since last open” inbox with a calm first-open baseline, saved-filter matching, and count-led mobile launch screen.
- [x] Add signed-in swipe-left save for later, synced to the responsive web Saved queue and official-form handoff.
- [x] Add local swipe-right hide with Undo and Profile-based restore.
- [x] Add cursor-based endless scrolling through every role in the selected availability catalog.
- [x] Let notification recipients leave grouped new-match releases for the full catalog from either the release footer or the Roles tab.
- [x] Repair catalog index drift and add a guarded operator repair, daily full-table invariant audit, metric, and alarm for open, closed, and nontechnical jobs.
- [x] Complete issue #50's provider-neutral posting identity, source matching, historical repair, and continuous integrity gate.
  - [x] Carry provider-scoped reviewed evidence through ingestion, reconcile standard/apply/tracking/custom-host variants without fingerprint or general internal-ID merging, preserve legacy job-ID lookup, and add the guarded D1 repair workflow without letting posting identity establish employer, destination, catalog, or alert eligibility.
  - [x] Report employer/name/title/location/destination and future #120 admission disagreements, and refuse repair apply while any matched group lacks a reviewed presentation decision.
  - [x] Deploy runtime support and save the production dry-run report, while deferring unresolved production consolidation until #120 supplies reviewed admission and presentation decisions.
  - [x] Reconcile tenant-less Greenhouse embed URLs in both arrival orders only when one active reviewed checkpoint proves the provider scope; leave ambiguous public IDs separate.
  - [x] Add durable confirmed/unconfirmed/quarantined occurrence decisions through one contract-versioned registry covering reviewed provider routes, authoritative requisitions, reviewed canonical URLs, stale evidence, and every conflict class without generic-URL or display-field merging.
  - [x] Replace live alias/job/occurrence/outbox sequencing with an atomic memory, DynamoDB, and D1 posting-observation commit and deterministic occurrence projection, including concurrency, rollback, and one-alert regression coverage.
  - [x] Add the immutable D1 review ledger, sanitized unknown-family queue, versioned audit/gate, notification-tombstone repair, shadow publication flag, and accessible unconfirmed status across catalog, detail, Saved, grouped results, push, and email.
  - [x] Deploy migrations `0010_posting_identity.sql` and `0011_issue_50_reviewed_employer_identity.sql` with unconfirmed publication disabled, verify the recurring audit, archive a passing production shadow audit, validate the compatible client contract and all affected roles, then obtain owner approval before enabling publication. Physical-device release acceptance remains in the release checklist rather than this backend rollout.
  - [x] Apply the combined reviewed repair with exact token/count guards, then verify zero remaining approved candidates, legacy links, projections, saved applications, and unchanged notification/outbox counts. Production completed on 2026-09-01 with 4,339 confirmed and 1,746 unconfirmed occurrences, 71.30649137222679% confirmed coverage, zero gate violations, all 12 official destinations healthy, and 384 outbox rows unchanged. The owner waived the gating 24-hour observation; early issue #151 follow-up found a snapshot-pinned floor regression with every structural blocker still zero. PR #153 restored convergence, the guarded normalization returned every mutation count to zero, all 12 roles passed re-verification, and publication resumed at a buffered 70% floor with 4,480 confirmed and 1,873 unconfirmed occurrences.
- [ ] Complete issue #124's high-priority normalized display contract across catalog cards, grouped results, role detail, saved roles, and notification previews without company-specific mappings.
- [ ] Complete issue #134's employer metadata enrichment rollout.
  - [x] Add versioned provider-neutral evidence extraction and deterministic reconciliation for ATS, structured JSON-LD, exact server-rendered pages, and Browser Rendering artifacts; retain distinct applicable pay ranges, bounded field excerpts, title-only evidence, conflicts, and projection repair.
  - [x] Add additive D1 evidence/history, conflict and guarded repair tables plus operations-only collection, dry-run, apply, verification, and CLI workflows.
  - [x] Apply migrations `0015_role_metadata_enrichment.sql` and `0016_role_metadata_repair_plans.sql` and deploy the Worker while preserving production publication settings (2026-09-05).
  - [x] Audit all 1,453 public roles missing pay and add regressions for confirmed disclosure formats; record recoverability and acquisition limits in [the coverage audit](role-metadata-coverage.md).
  - [x] Expand exact-role API acquisition to Greenhouse, Lever, Ashby, Workday and SmartRecruiters; retain native/unknown-period pay and publisher range labels; add shared display formatting, fair reserved scheduling, host backoff and resumable coverage reports in PR #161.
  - [x] Apply migration `0017_metadata_acquisition.sql` and deploy the expanded Worker/web with production flags preserved (2026-09-06); browser-check Salesforce pay on card and detail. Fix Worker API redirect handling, legacy collection eligibility and bounded repair staging from production validation.
  - [x] Deploy extraction v7 with paragraph/list boundaries, degree/job-level pay tiers, encoded ranges, dotted Ashby boards and exact Greenhouse embed routing. Verify live examples and retain pay across all 53 replayed postings without the 52 reproduced conflicts.
  - [x] Implement and deploy housing support/cost evidence and detail display, broader metadata correctness checks, additional pay formats, and explicitly reviewed omissions with atomic evidence/review guards (migrations 0018–0019). V9 corrects adjacent pay/benefit attribution found during production collection. Historical publication requires the remaining rollout gates below.
  - [x] Preserve accepted metadata during mixed-version refresh, require full source re-extraction after parser/preprocessing changes, report and gate deferred projections, retain source pay-tier boundaries, and recover exact Greenhouse APIs after staged browser inspection without cross-job admission writes. Runtime `fba716c` is deployed; failed destinations and source refreshes still require production validation.
  - [x] Fix live QA findings: v10 excludes Varda's cell-phone reimbursement from salary without dropping wages/housing; web controls expose accessible states, inactive guest screens leave the keyboard order, and company coverage wraps at 320px. Runtime `eee0205` and web `9e55df6` are deployed; fresh v10 collection and historical publication remain gated.
  - [x] Check all three EAS API environments and local mobile configuration against the Cloudflare Worker; correct development/preview targets while retaining AWS rollback resources. Native binaries require a separately approved rebuild.
  - [x] Complete the initial 100-role blind sample and 30-role holdout with independently adjudicated evidence and explicit unresolved cases; add v12 authority/currency regressions and bounded large-cohort D1 audits/repairs. Validate native live housing/pay and the large-text Apply layout on iPhone Simulator.
  - [x] Correct explicit housing cadence, application-scoped rolling/numeric deadlines, role-scoped work modes and yearless publication timestamps in v13; preserve unknowns, negations and conditions with regression fixtures.
  - [x] Add field-level production evaluations and make exact-revision shadow receipts project reviewed location/work-mode evidence without changing notifications; schema v5 canonicalizes work modes and treats absent fields in truncated inputs as incomplete.
  - [x] Reproduce and fix legacy 404/410 metadata-refresh loops with durable quarantine/write-failure regressions, share Greenhouse regional-band normalization, and verify saved-role deletion stays inside the authenticated owner partition. Production source-cycle acceptance remains pending.
  - [x] Add durable destination-to-shadow handoff outcomes and retry failed handoffs, bound admission health/audit memory, and revalidate the live official-source registry (2026-09-09). Production verification and the 25-run schema-v5 quality gate remain pending.
  - [x] Bound existing GitHub sources' parser-upgrade refreshes to 20-row continuations with durable per-row/omission progress, retry-safe completion and no premature source-freshness certification. Verify complete production cycles before closing rollout.
  - [x] Add v14 regressions for explicit Magna school-year/degree pay rows and PayPal city/state bands; replay full official responses without inferring currency or unstated periods.
  - [x] Add three fixed, read-only trusted-catalog probes with offline official fixtures and bounded live public-vs-official comparison; they report discrepancies, blocked access, and unavailable evidence without repairing records or certifying catalog-wide accuracy.
  - [ ] Recollect current-version evidence, finish unresolved provider review, obtain exact repair approvals and rescore the published feed. See [the delivery plan](metadata-coverage-plan.md).
  - [ ] Finish and archive authenticated production collection/dry-run, obtain owner approval for each batch's exact token/counts, apply, and verify zero supported role-specific misses or projection-only omissions. The existing operations credential now works; collection has started, but no guarded backfill has been applied.
- [ ] Complete issue #99 catalog quality hardening and backfill.
  - [x] Add shared catalog normalization, structured locations/pay, defensive mobile presentation, and the guarded D1 repair workflow.
  - [x] Deploy the normalization and dry-run endpoint, then save the production dry-run report for owner approval.
  - [x] Apply the approved production repair with its exact token and changed-record count.
  - [x] Verify the post-repair audit, grouped projection, and unchanged job IDs/notification state through production D1 and API samples.
  - [ ] Verify representative iOS/Android rendering.
- [x] Separate catalog visibility from ingestion facts, keep provider baselines behind normal roles, and add the guarded 2026-08-09 Ashby recency repair.
- [x] Audit 25 representative employers through the GitHub Markdown ingestion and poller pipeline.
- [x] Add a provider-neutral company-coverage snapshot, public search API, and responsive web disclosure seeded from live internship evidence and reviewed ATS registries.
- [x] Implement the Greenhouse source adapter, admission gates, deterministic fixtures, and live contract tests.
- [x] Add the SQS-backed Greenhouse shadow/published runner with thirty-minute published polling, three-hour shadow polling, bounded per-board concurrency, isolated retries, alarms, and a quiet promotion baseline.
- [x] Publish the 166-board API-responsive Greenhouse inventory and admit 20 additional ownership-verified boards to production shadow monitoring, with current board identities, observed host allowlists, and per-source quiet baselines.
- [x] Add a private operations dashboard for all official Greenhouse sources with per-run volume, withheld rows, redacted diagnostics, queue/DLQ and alarm status, plus deterministic quarantine and recovery.
- [x] Add bounded 512-KiB application-page evidence, quarantine-enforced scheduling, protected selective operations for all six Cloudflare DLQs, and exact GitHub queue failure attribution.
- [ ] Complete issue #28's registry-driven provider rollout.
  - [x] Add the shared catalog-provider registry, forward-compatible source health, capability-aware operations metadata, isolated provider availability, and registry-resolved AWS/Cloudflare fleet telemetry for Greenhouse, Lever, Ashby, and GitHub.
  - [ ] Deploy the Worker/Terraform binding update and update the separately deployed private monitoring console to render `providers`, unavailable integrations, and only advertised controls before closing #28.
- [ ] Add the Greenhouse batch re-probe and post-publication ownership-review workflow described in [`greenhouse/registry-expansion-plan.md`](greenhouse/registry-expansion-plan.md).
- [x] Implement Lever source adapter, ETag checkpoints, technical-role mapping, and deterministic fixtures for Palantir, PlusAI, Hermeus, and Xsolla.
- [x] Add the SQS-backed Lever shadow/published runner with thirty-minute published polling, three-hour shadow polling, bounded per-board concurrency, isolated retries, alarms, and quiet promotion.
- [x] Standardize Greenhouse, Lever, general Markdown, and Quant Markdown behind neutral complete snapshots, shared processing, stable source occurrences, two-success closure reconciliation, deterministic outbox IDs, and durable source health.
- [x] Complete Lever monitoring with shadow and published health, regional metrics, freshness incidents, bounded backoff, shared operator controls, dashboards, and recovery runbooks.
- [x] Verify ETag behavior across representative Greenhouse and Lever boards, repair Greenhouse 304 classification, remove Lever's ineffective conditional path, and emit sanitized conditional-request metrics.
- [x] Add Ashby URL-derived discovery, metadata-only public probing, first-party ownership evidence, deterministic admission/re-verification gates, weekly candidate-ledger upload, and 35 reviewed shadow boards.
- [x] Implement the Ashby public posting adapter with listed-only complete snapshots, strict identity/schema/link gates, provider-neutral processing, deterministic fixtures, and a nightly live contract for every reviewed board.
- [x] Close the original Ashby emergency-promotion follow-up: all 35 original boards have refreshed first-party ownership evidence, normal 24-hour promotion evidence without overrides, and healthy production validation. The seven previously quarantined boards completed forced recovery on 2026-08-14 and resumed with empty work and dead-letter queues.
- [x] Admit and immediately publish Sentry as the 36th reviewed Ashby board on 2026-08-18 with explicit owner approval; its known internship was public but unlisted in the board API, so the direct monitor covers future listed roles while community sources retain the current occurrence.
- [x] Scan the live community catalog and deploy 109 newly ownership-verified sources to production shadow monitoring on 2026-08-18: 61 Ashby, 28 Lever, and 20 Greenhouse boards. The first batch admitted 44 sources through static evidence, and owner-reviewed browser verification admitted the remaining 65 exact ATS tenants.
- [ ] Recover the three long-tail empty boards (`greenhouse-emergingtalent`, `ashby-blockhouse`, `ashby-egra`) to healthy idle monitoring.
  - [x] Add reviewed `emptyBoardAcknowledged` declarations so a genuinely empty board is dormant instead of a recurring raw-zero quarantine, with the live identity re-check recorded per board.
- [ ] Complete Sentry's normal promotion observation follow-up after 2026-08-19T01:18:19Z and remove the temporary observation-window override.
- [x] Add Ashby application-assistance route detection and headed-browser workflows after runtime promotion; this remains separate from source ingestion. Published reviewed boards are eligible automatically.
- [x] Add human-readable source tags to default internship notifications for community job boards and published Greenhouse, Lever, and Ashby sources.
- [x] Add job freshness, verified employer-posted versus unverified source-reported versus InternNotifs-found timing across mobile, responsive web, and alerts, official/community provenance labels to role details and every catalog or saved-role card, filter-match explanations, hybrid New/New here status, and duplicate-safe notification deep links, including closed and unavailable states.
- [x] Add migration-safe structured internship/posting identity, conservative ATS alias reconciliation, grouped catalog/release APIs, permanent delivery-claim semantics, quiet-hours release modeling, and the reusable encrypted SNS/SQS notification construct.
- [ ] Activate the grouped notification construct with production batch workers, TestFlight-owner allowlisting, Firehose/Athena audit exports, and measured 15-second p95 delivery before disabling the legacy direct sender globally.
  - [x] Wire the production stream, aggregation, flush, personalized push/email, receipt, release-deep-link, and materialized catalog workers in infrastructure.
  - [ ] Execute the guarded identity/receipt migration, deploy to an owner-only cohort, export delivery audits, and measure the 15-second p95 gate.
- [x] Add user-facing settings with separate user-info, job-preference, and app/account destinations, including account deletion.
- [x] Keep official-form opens from immediately changing application status; signed-in Apply clicks start role-specific confirmation checks, while only Save, manual status changes, or confirmed Gmail detections create or advance records.
- [x] Implement optional Gmail read-only OAuth, encrypted credential storage, Apply-triggered checks at 5 minutes, 10 minutes, 30 minutes, and 24 hours, bounded transient content matching, role-scoped confidence scoring, review/dismiss actions, disconnect/account-deletion cleanup, queue retries/DLQ, and mobile connection/review states.
- [x] Update privacy, retention, store-disclosure, support, frontend, deployment, and roadmap documentation for transient Gmail content processing and Google Limited Use.
- [ ] Complete Gmail live acceptance with OAuth-console test users and representative confirmations. OAuth connection and the needs-review queue were validated in production on 2026-08-26; a SpaceX Apply-triggered confirmation was detected and marked Applied in production on 2026-08-27; revoked-grant recovery was revalidated during the 2026-09-08 OAuth secret rotation. Additional employer confirmations plus cancellation, accept/dismiss, disconnect, and account deletion remain.
- [ ] Complete Google restricted-scope verification and the required annual third-party security assessment before enabling Gmail detection outside test users.
- [ ] Reconcile Gmail email-content processing in App Store Connect and Google Play Console, then release to closed beta before general availability.
- [x] Add a user-facing data export surface.
- [x] Add source-quality reports, drift gates, nightly live probing, source-candidate review artifacts, and Firecrawl discovery-only workflow.
- [x] Define the shared headed/headless application-session state machine and trust boundaries.
- [x] Keep official-form opens from directly changing application records; Save is the explicit To Apply action and Applied requires a manual or confirmed Gmail transition.
- [x] Add the reviewed default-deny assistance policy, versioned session API, short-lived handoff credentials, and session metadata TTL.
- [x] Define and test Greenhouse and Lever high-confidence route detection plus the simple-field, review-only, and never-fill policy.
- [x] Build a local-only headed, no-submit browser companion pilot for reviewed Greenhouse and Lever test forms.
- [ ] Add the application review and verification-handoff experience.
- [ ] Prototype an isolated headless runner after the headed pilot establishes reliable field mappings.

### Product owner

- [x] Recreate the official reference icon as an editable vector and configure matching website favicon, Apple touch icon, and native iOS assets for the next TestFlight build.

- [ ] Reactivate AWS account `628031636041` long enough to export retained development data and approve the final Cloudflare cutover; do not delete retained resources during migration.

- [ ] Connect a GitHub account/repository with permission to create a GitHub Project and issues.
- [ ] Create a deploy-only AWS role or Identity Center permission set; stop using root credentials for deployment.
- [ ] Decide the default geographic emphasis for discovery ranking and the mobile experience; do not gate source verification on a hand-selected roster.
- [x] Approve the live privacy, terms, retention, and source/correction policies and confirm `onlinestuff309@gmail.com` as the public support mailbox on 2026-08-26.
- [ ] Enroll in Apple Developer Program and Google Play Console when beta builds are ready.
- [ ] Recruit 30–50 beta testers with iOS and Android devices.

## Metrics for closed beta

| Metric | Initial target |
| --- | --- |
| Source freshness | 95% of listed open roles checked within 90 minutes |
| Duplicate alert rate | Under 2% |
| Alert relevance | At least 70% of surveyed alerts rated relevant |
| Alert-to-detail open rate | At least 30% |
| Alert-to-application handoff | At least 10% |
| Notification retention | At least 60% of active testers still opted in after 14 days |

## Decisions log

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-09-04 | Trust only `simplify-summer-2026` for source-reported catalog admission, with catalog exposure default-off and alerts activated later by source-policy version | A validated official handoff can support useful browse coverage without falsely claiming canonical employer or posting identity; a quiet baseline and two complete snapshots prevent backlog alerts |
| 2026-09-01 | Use a buffered 70% posting-identity coverage policy floor instead of pinning enforcement to the exact activation snapshot | Reviewed-community growth legitimately changes the confirmed/unconfirmed source mix; structural identity blockers and a policy low-water mark detect corruption without turning normal ingestion into a failed daily audit |
| 2026-09-01 | Enable unconfirmed posting-identity publication after the guarded repair and waive the final 24-hour acceptance gate while retaining a non-gating follow-up | The guarded production repair converged, every integrity blocker was zero, the enforced scheduled audit passed, all affected aliases and official destinations were verified, and publication status remains explicit to users |
| 2026-09-01 | Expand exact posting identity first through collision-free provider-owned routes | Tesla, Meta, Jane Street, Goldman Sachs, and IMC expose immutable numeric posting IDs on narrowly scoped official hosts; larger ATS families remain unconfirmed when historical duplicate jobs still need a reviewed presentation decision |
| 2026-07-19 | Initial audience is international undergraduate/graduate students | Broader early-career reach; filters must support work authorization and location needs |
| 2026-07-19 | Initial roles are technical | Focus increases catalog quality and relevance |
| 2026-08-09 | Initial lifecycle scope includes internships, co-ops, apprenticeships, new-grad programs, and explicitly entry-level roles | Matches how employers label student and first-role hiring while excluding generic or merely junior titles |
| 2026-07-19 | Use official-form handoff, not universal direct submit | Better reliability and employer authorization boundary |
| 2026-07-20 | Explore headed assistance before headless preparation; require user review, verification, and final submit | Keeps the user in control while establishing reliable field mappings and challenge rates |
| 2026-07-29 | Track company coverage separately from any ATS provider and distinguish feed observations from reviewed direct sources | Makes broad discovery measurable without overstating community-list evidence as employer verification |
| 2026-07-19 | GitHub Project will be the shared external tracker | Fits open-source workflow and links work to code/issues |
| 2026-07-19 | Use FAANG, startup, and normal as the initial company-type filters | Small, understandable filters; startup begins with a reviewed YC-backed allowlist and unknown employers remain normal |
| 2026-08-25 | Operate as JD Krasnick under Pennsylvania law, require separate 18+ and policy signup attestations, and use the published private support email for personal-data requests | Provides a clear accountable operator and consent record without collecting date of birth |
| 2026-08-25 | Retain active account data until deletion, abandoned unverified signups for 7 days, inactive anonymous installations for 12 months, delivery records for 90 days, and assistance metadata for 30 days | Keeps product state available while bounding operational and abandoned data |
| 2026-08-25 | Publish code under MIT and InternNotifs-authored catalog metadata under CC BY 4.0, excluding employer text, trademarks, and third-party material | Supports an open-source project without relicensing material InternNotifs does not own |
| 2026-08-25 | Acknowledge source corrections within 2 business days, target resolution within 7 days, and promptly hide credible safety-sensitive listings during review | Makes the public correction path predictable while prioritizing user safety |
| 2026-08-26 | Require reviewed canonical employer identity, posting attribution, a single-role official destination, and complete display metadata before catalog or alert admission | Prevents aggregate boards, broken handoffs, generic employer labels, and malformed cards from reaching students while preserving source evidence and saved history |
| 2026-08-26 | Make Gmail confirmation detection optional, deterministic, account-gated, and triggered for one role at 5 minutes, 10 minutes, 30 minutes, and 24 hours after Apply; keep it unavailable to general users until restricted-scope verification and annual security assessment are complete | Reduces manual tracking without treating a link open itself as a completed application |
| 2026-08-27 | Upgrade Gmail detection to read-only access and transiently inspect bounded message text; require authoritative employer, requisition, or provider-tenant evidence for automatic confirmation and route weaker matches to Possibly applied | Message content is needed to distinguish confirmations with generic subjects while avoiding same-ATS, same-title false positives; content is not persisted or logged |
