# New since last open

## Product behavior

When a signed-in, onboarded user launches InternNotifs, the Roles tab opens the focused inbox when new roles matched their saved alert filters since the last app launch. The headline states the count and interval; cards use the existing role-detail sheet and official-form handoff. One secondary action, **Browse the catalog**, switches to the Discover tab, where the swipe deck of open roles lives.

An empty interval should not interrupt browsing: the Roles tab shows a quiet empty state whose **Review roles** action opens the Discover tab. A user’s first launch after this feature ships establishes their baseline and shows no historic backlog. Guest browsing stays unchanged and never records a personal launch time.

![Count-led launch-inbox mockup](mockups/new-since-last-opened-v2.png)

## Visual and navigation direction

Make the count the visual hero: `4` becomes the large headline, followed by **new matches** and then the compact interval, “Matched your alerts since Fri, Jul 17.” This directly answers the user's first question—how much changed—without spending the largest type on a sentence they already understand from context. Keep **View all** as the one quiet secondary action.

Replace the current top text tabs with one persistent bottom bar: **Roles**, **Queue**, **Discover**, and **Profile**. Each target has a familiar icon above its one-word label: a filled briefcase for the selected Roles tab, albums for Queue, layers for Discover, and person for Profile. The selection uses ink and a filled icon; inactive tabs use muted slate and outline icons. Do not use the bar for actions or hide labels.

This is a particularly strong fit for the product's peer sections. Apple's current guidance describes tab bars as navigation between top-level sections, recommends fewer tabs, persistent availability, short labels, and familiar SF Symbols; Android's guidance likewise recommends a bottom navigation bar for three to five equally important, persistent destinations in compact windows. The direction also follows Apple's principle of clear hierarchy and concise wording.

Sources: [Apple tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars), [Apple SF Symbols](https://developer.apple.com/design/human-interface-guidelines/sf-symbols), [Android navigation bars](https://developer.android.com/develop/ui/compose/components/navigation-bar), and [Apple design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles).

## Walkthrough mockups

1. [New matches at launch](mockups/new-since-last-opened-v2.png)
2. [Browse open roles](mockups/roles-feed-v4.png)
3. [Open a role and hand off to the official employer application](mockups/role-detail-sheet.png)
4. [Track saved applications](mockups/saved-applications.png)
5. [Tune alerts and matching filters](mockups/profile-alerts.png)

At most 50 cards are included in the launch inbox. When more roles match, show the total plus a concise “Showing the newest 50” note and preserve **Browse the catalog** as the route to the Discover tab.

The launch inbox is the whole Roles tab: there is no separate "new versus seen" grouping inside a feed. Earlier matches stay out of the inbox; the Discover tab is the one place a reader works through the open roles a card at a time.

New cards get a little reward without becoming a distraction: on first render, they rise 8 pt while a pale-teal sheen fades once; the first five cards stagger by 80 ms. A tiny sparkle-and-**New** marker remains for recognition after the motion ends. There is no looping or pulsing animation, and Reduce Motion displays the same cards without animation. This follows React Native’s [AccessibilityInfo](https://reactnative.dev/docs/accessibilityinfo) Reduce Motion API and its native-driver [Animated](https://reactnative.dev/docs/0.82/animated) guidance for opacity and transforms.

## API contract

`POST /installation/opening` uses the anonymous installation bearer token and
has no request body. The authenticated `POST /me/opening` route has the same
contract for backwards compatibility. Both return:

```json
{
  "jobs": [],
  "total": 0,
  "hasMore": false,
  "previousOpenedAt": "2026-07-18T12:00:00.000Z",
  "openedAt": "2026-07-19T12:00:00.000Z"
}
```

`jobs` are normal-recency open technical early-career roles whose `catalogVisibleAt` is strictly after `previousOpenedAt` and no later than `openedAt`, after applying the saved role and employer filters. Baseline roles never enter this inbox. The call then records `lastCatalogOpenedAt`. On first use, `previousOpenedAt` is `null`, with no jobs and no historical scan.

The implementation uses the existing `openJobsIndex` and its recency-rank plus `catalogVisibleAt#jobId` sort key, so it needs no new DynamoDB index. Saving profile/alert preferences preserves the launch marker.

## Mobile integration

After installation preference loading, the mobile client calls
`POST /installation/opening` once per app launch, regardless of account state.
Signing in or out does not replace or advance the device's opening interval. If
`total > 0`, the Roles tab shows the inbox; otherwise it shows a quiet empty
state whose **Review roles** action opens the Discover tab. The mobile shell
uses the persistent bottom Roles, Queue, Discover, and Profile navigation
specified above. The Roles tab is the new-matches surface: it renders the launch
inbox itself and falls back to the same quiet empty state. The inbox is not a
push notification, badge, or new tab: it is a calm, launch surface. Job cards
retain the current role-detail and employer-official-application behavior.
