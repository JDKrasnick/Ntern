# InternNotifs frontend design

## The design to build

InternNotifs should feel like a sharp personal job-search tool, not a generic form app. The interface needs enough personality to be memorable, while staying quiet when a user is scanning opportunities.

Adopt **Focused Editorial** as the product direction:

- Use a warm off-white canvas, ink-black primary text, and one controlled teal signal color.
- Give each screen a clear editorial hierarchy: a small context label, a decisive headline, then the task.
- Let structure—not large empty areas, floating controls, or decoration—create calm.
- Use compact surfaces with clear borders instead of shadows everywhere.
- Make the primary action a solid ink button. Teal is for selected/filter states and useful metadata, not every interactive element.

This replaces the current "generic settings form" look with a more intentional, student-friendly product while preserving native iPhone conventions.

## What to correct from the current direction

The existing onboarding screenshot exposes four issues:

1. The form is vertically centered, leaving a very large unintentional blank area above it. Short setup screens should start near the top safe area and scroll when the keyboard appears.
2. The headline, chips, input, and button do not share a consistent visual rhythm. They need one content column, predictable gaps, and matching control heights.
3. The system mixes default blue text buttons with custom outlined chips. A primary action should read as a real, full-width action.
4. Large all-caps chip labels and placeholder-only fields make the product feel more like a prototype than a tool users can trust.

## Alternative art directions

Use these as discussion samples before changing the direction again. The first is recommended because it is distinctive without making job information harder to scan.

| Direction | Sample personality | Best use | Risk |
| --- | --- | --- | --- |
| **Focused Editorial (recommended)** | Ink, off-white, teal signal; strong type and slim bordered cards | A calm all-purpose mobile product | Requires restraint with the teal accent |
| Utility Ledger | White, graphite, blue; dense rows and status labels | Power users tracking many applications | Can feel sterile and crowded for first-time users |
| Opportunity Radar | Deep navy, electric aqua, brighter status chips | A more energetic discovery experience | Can overemphasize decoration and make alerts feel noisy |

### Focused Editorial sample: onboarding

```text
YOUR ALERTS
Make InternNotifs yours.
Pick the roles worth interrupting you for. You can change this at any time.

Role categories
[ AI/ML ] [ Grad ] [ SWE ✓ ] [ Quant ]
[ Product ] [ Design ]

Specific keywords (optional)
[ e.g. backend, robotics, research                    ]

[              Enable alerts and continue              ]
We’ll ask for notification permission next.
```

The content starts 42 pt below the safe area, with a 20 pt gutter on both sides. The chips wrap naturally, but every chip keeps a 48 pt minimum height. The action is full-width and visually grounded.

### Focused Editorial sample: catalog grid

```text
[ ⌕ Search roles, companies, locations              ✕ ]
[ Filter roles 3 ]  [ Summer 2027 ✕ ] [ SWE ✕ ]  Clear all
5 employers · 6 roles

6 new roles since Thu    Freshly matched your alerts
┌───────────────────────┐ ┌───────────────────────┐ ┌─────────
│ SWE           ●New here│ │ AI/ML        ●New here│ │ Quant
│ Acme Robotics          │ │ Acme Robotics         │ │ Northst…
│ Software Eng. Intern   │ │ Machine Learning Int. │ │ Quantitat…
│ Austin, TX · summer-27 │ │ Austin, TX · summer-27│ │ New York…
│ $45/hour               │ │ $45/hour              │ │ $45/hour
│ Found by Ntern 10h ago │ │ Found by Ntern 10h ago│ │ Found by…
│ In queue        Hide  Queue │ │            Hide  Queue │ │    Hide  
└───────────────────────┘ └───────────────────────┘ └─────────

[▣ Roles]        [▤ Queue]        [⌕ Catalog]        [◯ Profile]
```

Navigation, search, headers, tokens, the newness lane, and tiles all align to the same 20 pt edge. Tiles are 14 pt radius with a one-pixel slate border and a 12 pt gap—no floating or shadow-heavy treatment. The grid shows two columns on a phone, three on a tablet, and four on a wide desktop, and every tile footer names its own action.

### Focused Editorial sample: settings

```text
Settings

User info                                           ›
Contact details and résumé for application help.

Job preferences                                     ›
Alerts and filters for the roles you want to follow.

App & account                                       ›
Hidden roles, notification wording, privacy, and account controls.
```

Profile opens as a short Settings list with three focused destinations: **User info**, **Job preferences**, and **App & account**. Each destination is independently scrollable. Inputs, buttons, chips, and section headings never acquire an extra local horizontal margin; only the page container owns horizontal padding.

## Design tokens

| Token | Value | Use |
| --- | --- | --- |
| Canvas | `#F8FAFC` | All page backgrounds |
| Surface | `#FFFFFF` | Inputs and cards |
| Ink | `#0F172A` | Headlines, primary actions, active navigation |
| Body | `#334155` | Standard control text |
| Muted | `#64748B` | Supporting copy and inactive navigation |
| Border | `#CBD5E1` | Inputs and neutral chips |
| Soft border | `#E2E8F0` | Card and section separation |
| Signal teal | `#0E7490` | Selected category, company metadata, eyebrow labels |
| Danger | `#B91C1C` | Destructive action only |

Use a four-point spacing scale: `4, 8, 12, 16, 20, 24, 32, 44`. Standard controls are 52 pt high; chips are at least 48 pt high so they meet Android's larger touch-target guidance while remaining comfortable on iPhone.

The current release intentionally ships a light appearance only. Do not claim automatic Dark Mode until semantic light/dark token sets and physical-device checks exist; a consistently light interface is preferable to a partially inverted one.

Typography should stay simple:

| Use | Style |
| --- | --- |
| Context / eyebrow | 12 pt, bold, 1.1 pt tracking |
| Screen title | 32 pt, extra-bold, slight negative tracking |
| Section title | 22 pt, bold |
| Job title / primary content | 17 pt, semibold or bold |
| Body / input | 16 pt, regular |
| Supporting metadata | 14–16 pt, regular |
| Helper copy | 13 pt, regular |

## Layout rules

Every screen follows these rules. They are as important as colors and type.

1. Use a 20 pt horizontal page gutter. Lists receive the gutter through `contentContainerStyle`; individual cards and inputs must not add their own horizontal margins.
2. A content screen starts at the top of the safe area. Only deliberate empty, success, or account-gate states may center their content.
3. Keep a 12 pt gap between related controls, 24 pt between form groups, and 32 pt between major sections.
4. Use one full-width primary action per task. Secondary actions are outlined; destructive actions are separated and red.
5. Use `KeyboardAvoidingView` plus a scroll view for every form. The submit action must remain reachable with the keyboard open.
6. Do not rely on a placeholder as a label. A visible label is required for profile and preference fields; onboarding may pair an obvious field label with a concise placeholder.
7. Allow text to wrap rather than force long role or company names into fixed-height rows.

## Component recipes

### Bottom tab navigation

- Fixed at the bottom of the app content, with a one-pixel top separator and safe-area space below it.
- Four equal-width, 52 pt minimum targets: Roles, Queue, Catalog, and Profile.
- Every tab combines a familiar icon with a short text label. Use a filled briefcase for the selected Roles tab, albums for Queue, search for Catalog, and person for Profile.
- Active tab: ink icon and label; inactive tabs: muted outline icon and label. Do not use a bottom-rule-only state or blue system buttons for navigation.
- A tab bar is for moving among these four top-level areas, never for inline actions. Keep it visible while switching sections.
- At 700 pt or wider, replace the bottom bar with the same four destinations in a compact left navigation rail; keep the primary content column centered and no wider than 760 pt.

### Input

- 52 pt high, 12 pt radius, white surface, `#CBD5E1` border.
- 14 pt horizontal inner padding.
- Pair with a 13 pt semibold label, 7–8 pt above the field.
- Use 12 pt after the field unless it completes a group.

### Filter chip

- Minimum 48 pt high; 14 pt horizontal padding; fully rounded.
- Neutral: white surface, slate border, body-colored label.
- Selected: pale teal surface with teal border and dark-teal label.
- Excluded: pale red surface with red border; reserve this state for explicit exclusions only.

### Catalog search and grid

- The Catalog tab is search-first. A pinned query field owns the top of the screen: a leading search icon, a trailing clear control, and a placeholder that names what is searchable (*Search roles, companies, locations*). Focus is visible as a 2 pt teal border; the caret and text selection are teal.
- Keep the field on the whole row at every width, with the filter control beside it; below 560 pt the filter control drops to its own line so the placeholder is never truncated.
- Show the live result count under the field — employers and roles, plus the query when there is one. A query narrows the grid and the newness lane together; there is no separate search screen.
- Active facets appear as removable teal tokens under the field, in the same words the filter sheet uses, followed by one quiet **Clear all**. Removing a token must leave every other facet untouched. When nothing matches, the empty state names the query and offers **Clear search** or **Clear filters** rather than a dead end.
- Results are a dense tile grid, not one tall column: 2 columns below 840 pt, 3 up to 1400 pt, 4 above, and 3 when the desktop queue sidebar is open. Compensate a row that is not full with invisible cells so tiles keep one width.
- A tile is the compact form of a role card: discipline pill and **New here** marker, employer, role (up to three lines), location and season, compensation when known, the identity/closed notices, then a footer that names its own actions (**Hide**, **Queue**, or **In queue**). Tiles in a row are equal height and their footers align; use 14 pt radius and 13 pt padding for this denser form.
- The tile surface keeps the card vocabulary: white surface, one-pixel soft border, teal employer text, ink role text, muted meta. A tap opens the role or the employer group exactly as the tall card does, and queue and hide mean the same thing in both forms.
- On the web, `/` focuses the query field and `Esc` clears it.

### Newness lane

- Above the grid, and only when the launch release contains roles, show one horizontal lane of large tiles: **N new roles since <interval>** with **Freshly matched your alerts**. The lane is the top of the catalog, not a second product.
- Lane tiles are the same tiles at the larger size: they spell out their actions and add the freshness line. Only roles that are genuinely in the release carry the **New here** marker; grid tiles never claim newness without it.
- The lane is a snap scroller with a deliberate peek of the next tile. Never wrap it into a second row, never loop it automatically, and never badge it.
- With no new roles the lane is simply absent: the search spine and the grid stand alone. Do not substitute an empty lane or a "nothing new" banner in the catalog — the Roles tab owns that message.

### Release calendar

- The catalog's release days are a calendar question, not a filter-sheet question. A small **Dates** control sits at the top right of the search spine and opens a month grid over the grid — it never reflows the catalog and never becomes a modal.
- A day has a *release* only when roles became visible that day. Days with releases show that day's role count; days without are inert and visibly quiet. Never offer an empty day as a choice.
- Selecting a day fills it, closes the calendar, and narrows the catalog to that day's roles. The choice joins the other facets as one removable token, so **Clear all** and the sheet stay the single place a reader un-narrows the list.
- The day is read in **UTC** by default, so a role's release day is the same day for everyone and matches what alerts and release cards call it. The footer states which calendar is in force, and it never shows a bare count without saying what the count is.
- **App & account → Release calendar dates** offers **UTC** or **Device time**. Device time is the reader's own clock, so a role that lands after local midnight counts toward the next day; changing it re-reads the calendar and any selected day.
- Choosing a day that holds nothing for the current facets is not a dead end: the empty state names the day and offers **Clear day**.
- The index request carries every other active facet, so the counts describe what the reader would actually see.

### Card

- White surface, 16 pt radius, 16 pt internal padding.
- One-pixel soft border; no required shadow.
- 12 pt gap between cards.
- Company is teal metadata, role is ink, and location/season is muted body text.
- When the signed-in user has an application record for the role, display its current status in a compact teal pill. Opening the employer form does not immediately create or change that record. For signed-in users it creates a short-lived, role-specific Gmail check intent; show **APPLIED** only after a manual status change or a confirmed Gmail detection. Continue to show later statuses such as assessment or interview.

### Queue from a role card

- The only role-level action is adding the role to the apply queue; there is no separate "save for later". A deliberate left swipe on a role that is not queued reveals a teal bookmark action and adds it. The card returns to its resting position and shows its **In queue** state; do not remove it from the list.
- The reveal uses a short 100 ms follow-through and 120 ms hold before the card settles back. With Reduce Motion enabled, queue immediately without movement.
- Queuing never opens the employer form. **Open official application** remains the clear primary handoff wherever the queue is listed, and the same account-backed record is available in the responsive web app's queue panel. Keep status changes explicit; opening a form alone must not mark a role applied.
- **Remove from queue** deletes the record; **Add to queue** restores it for a record that is saved but not queued. Do not offer the delete action for a record that already carries an application status.
- If a queued role remains open but fails catalog admission, preserve its title, employer, location, season, and application history. Replace the handoff with the quiet shield notice **Ntern couldn't verify the official role page and is reviewing it.** Do not expose the unverified URL or application-assistance action. Closed roles keep the established closed state instead.
- Expose the actions to assistive technology as **Add to apply queue** and **Remove from queue**, with a hint that the role can be applied to later.

### Hide from feed

- A deliberate right swipe hides a role on the current device only. Reveal a subdued **Hide** action, then remove the card after its short follow-through; this must never remove the role from the catalog, the apply queue, or alerts.
- Replace the card in place with a quiet, static **Role hidden on this device · Undo** row. It is not a popup or toast: it remains in the role's list position for the current session, so Undo is immediate. Hidden roles are also listed in Profile and can be restored individually.
- Expose **Hide on this device** as an assistive-technology action. A card with both actions must describe left swipe to queue and right swipe to hide.

### New roles

- The Roles tab is the new-matches surface: it renders the launch inbox itself when the release contains roles, and a quiet empty state that links to the Catalog when it does not. Do not re-open the catalog behind the inbox or split the feed into new and seen sections.
- Cards use the existing role-detail sheet and official-form handoff, and the one secondary action is **Browse the catalog**.
- Give each new card a small, one-time arrival moment: an 8 pt lift, a soft teal sheen that fades within 420 ms, and a compact sparkle-plus-**New** marker beside the company. Stagger only the first five cards by 80 ms; never loop, pulse, or use a full-card neon treatment.
- Honor the device Reduce Motion preference by showing the card and static **New** marker without movement. The treatment uses opacity and transforms so it stays smooth without making the list feel busy.
- The Catalog tab carries the same release forward in its newness lane, so "new" means one thing across both surfaces.

### Posting identity certainty

- Treat posting identity as deduplication certainty, not as employer or application safety. Admission remains responsible for verifying that the employer and official application page are valid.
- When a published role has `postingIdentityStatus: "unconfirmed"`, show a quiet shield-and-**Identity unconfirmed** secondary label on role cards, detail, and Saved. It is informational, accessible text—not a warning color, blocking state, or competing action.
- On detail, explain: “We verified the employer and application page, but have not yet matched this listing to reviewed exact posting evidence. It may later be combined with another listing.” Keep **Apply on employer site** as the only primary action.
- Group cards report the number of unconfirmed roles. Individual and grouped notifications use the same plain-language disclosure. An absent status is a legacy record and must not be presented as confirmed or unconfirmed.

### Housing evidence in role details

- Show housing as separate evidence rows below the role details, keeping it separate from salary and base pay. Omit the rows when housing evidence is absent.
- Preserve the distinctions **Housing stipend**, **Employer-paid housing**, **Housing cost to you**, and **Housing available · cost not confirmed**. Availability alone must not imply free or employer-paid accommodation.
- Place a supported amount, currency, and period beside its housing label; append **conditional** when the evidence is conditional. Keep the employer’s source excerpt immediately below so eligibility and other conditions remain visible. The shared formatter bounds the excerpt to 240 characters and the display to eight rows.
- Reuse the sheet’s existing evidence treatment: bold body-colored labels, smaller muted source text, and wrapping rows in the scrollable content. Keep the official application handoff as the primary action for an open role.

### Buttons

- Primary: 52 pt, 12 pt radius, ink fill, white semibold label.
- Secondary: white fill, slate border, body-colored label.
- Danger: red fill, white label, separated from routine account actions.
- Never use bare colored text as the only primary action for a setup flow.

### Loading states

- Use static, layout-matched skeletons instead of activity wheels or progress bars.
- A loading catalog keeps the search spine still and shows tile-shaped skeletons in the same column count the resolved grid will use, so the layout does not jump.
- Let the app-loading shapes reveal from top to bottom: each starts 10 pt lower, then rises and fades in once over 240 ms, with a 100 ms stagger. Keep the surrounding chrome still, and never loop the animation or add a shimmer sweep.
- Respect Reduce Motion: show the completed skeleton layout immediately when it is enabled. The real roles should replace the shapes without an additional transition, keeping loading quick and legible.
- A loading profile uses headline, field-label, input, and button shapes in the same 20 pt content column as the completed form.
- Skeletons use `#E2E8F0`; buttons may use the slightly darker `#CBD5E1`. They are announced as loading content for assistive technology, but contain no visible loading text.

## Alert settings and application progress

Role matching and alert delivery settings live in the **Job preferences** destination. Keep that destination as one focused sequence; do not split it into another maze of sub-screens:

1. Alert permission toggle and role/keyword filters.
2. Company type: FAANG, startups, normal companies, or every company.
3. Optional exclusions for source-marked U.S.-citizenship and advanced-degree requirements. Do not add a sponsorship filter.
4. Delivery timing: immediate or daily digest.
5. Quiet hours: start, end, and timezone.

Notification presentation and application follow-up settings live in **App & account**:

1. Wording templates with a dark live notification preview.
2. Application reminders and a follow-up interval.
3. The release calendar's date zone (UTC or device time) — a device-local display choice, not an account preference.

Onboarding must always offer **Continue without alerts**. It may request notification permission only after the user deliberately enables the alert switch and confirms the setup action. If permission is denied, preserve the role preferences, show an inline explanation with a retry action, and never block access to the feed.

Every save uses the same inline feedback treatment: a neutral saving message, a green success confirmation, or a red readable error with **Try again**. Avoid transient spinner-only or alert-only save feedback.

Application progress comes from explicit user changes and, when the user opts in, Gmail application-confirmation evidence. Opening an employer form alone never creates or advances a record; it starts a bounded confirmation check for that exact role. A unique deterministic Gmail match may create Applied or advance Saved to Applied; assessment, interview, offer, rejected, and withdrawn statuses never regress. Automatic detections do not trigger push notifications. Do not imply that employer portals expose broader progress than a supported integration actually provides. Deadline reminders belong in the next delivery-service release and require a reliable source deadline.

### Gmail application detection

Place Gmail application detection in **App & account**. Before consent, explain in plain language that after an Apply click InternNotifs checks for that role after 5 minutes, 10 minutes, 30 minutes, and 24 hours, reading the sender, subject, date, labels, and a limited portion of message text. State that message text is not stored, attachments are not processed, and Gmail data is not used for AI or model training.

The connected state shows one Gmail address, syncing/connected/error state, last successful sync, retry when appropriate, and a destructive **Disconnect Gmail** action. Disconnect copy must explain that credentials, sync history, and pending detections are deleted while application statuses remain without Gmail evidence.

At the top of **Applications**, show ambiguous matches under a compact **Needs review** section. Each row names the confirmation subject/date and the candidate catalog roles; the user can choose one role or dismiss the detection. Automatically matched records show “Detected from Gmail · date” beneath the status. Keep review controls native, accessible, and secondary to the saved-application list.

The notification backend must apply the saved role, company-type, U.S.-citizenship, and advanced-degree filters, delivery cadence, quiet-hours timezone, and per-device deduplication before it delivers. Closed listings are browse-only and never trigger alerts. Use a concise internal role deep link for mobile pushes; the employer application URL remains the explicit handoff after opening a role.

## Screen intent

- **Browse / sign in:** establish trust quickly. Browsing remains useful without an account.
- **Onboarding:** select roles and enable alerts in under a minute. Explain the next permission step before triggering it.
- **Feed:** start with only search and filter controls, then the role list. Each card answers what, where, and when before any secondary detail; tracked roles also expose their current application status.
- **Apply:** make the handoff to the employer explicit. InternNotifs tracks progress; it does not impersonate an employer form.
- **Saved:** show a small, clear status model rather than a complex CRM workflow.
- **Profile:** separate application data, job preferences, and app/account controls into three clear Settings destinations.
- **Device ownership:** job preferences, push permission, and notification wording stay with the installation and remain available while signed out; only application data and user info are account-gated.

## Implementation acceptance checklist

- [ ] Every primary content edge aligns at 20 pt from the viewport.
- [ ] No card or form control adds a second horizontal margin inside a padded list/form container.
- [ ] Onboarding and profile are keyboard-safe and scrollable.
- [ ] The navigation tabs, input fields, chips, and primary buttons meet the minimum touch target.
- [ ] Default `Button` components have been replaced on product surfaces where they would break the visual system.
- [ ] All profile inputs have persistent labels before release.
- [ ] Empty, loading, error, and notification-permission states have specific plain-language copy.

## Authentication

The near-term sign-in screen is compact and email/password based: sign in, create account, and verify email. There is no shared default login; each tester creates their own account.

The intended iPhone-first end state is **Sign in with Apple** as the primary option, with email/password retained as a fallback. Do not present a non-working Apple button. Before enabling it, configure Apple as a Cognito User Pool identity provider and test the full token return path on a physical device.

Required configuration outside the app code:

1. Enable **Sign in with Apple** for `com.internnotifs.app` in Apple Developer.
2. Create an Apple Sign in with Apple key and record its Key ID, Team ID, and private key securely.
3. Create/configure the Apple Services ID and allowed Cognito callback URL.
4. Configure the Apple provider, Cognito hosted domain, OAuth callback/sign-out URLs, and allowed OAuth flows in the Cognito User Pool.
5. Add the mobile auth-session implementation, then test first sign-in, returning sign-in, private relay email, logout, account deletion, and a full TestFlight build.

The Apple private key must remain in AWS/Apple configuration and must never be embedded in Expo environment variables, the mobile binary, or Git.
