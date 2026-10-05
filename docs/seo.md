# Public search discovery

## Audit and priorities

The October 5, 2026 audit of `https://ntern.app` found an empty Expo root in the initial HTML, a title of only “Ntern,” no description or canonical, and HTML app fallbacks at both `/robots.txt` and `/sitemap.xml`.

The highest-return work is to make existing, useful catalog content discoverable before expanding content volume:

1. Give the homepage and policy pages descriptive metadata, clean production canonicals, a real robots file, and a sitemap. Keep Pages previews out of search.
2. Serve public role lists and individual role summaries as HTML with ordinary links and official application handoff. Return real missing/closed/error statuses. Bound API reads and avoid any direct D1 crawl workload.
3. Add a small set of distinct category pages with practical guidance and links to matching open roles. Avoid generating combinations of employer, city, year, and keyword pages with little distinct value.

The catalog API exposes summaries, not complete employer descriptions. Do not add `JobPosting` markup or use Google's Indexing API until complete visible descriptions, reliable employer posting dates, required location fields, and expiry handling meet Google's policies. Discovery dates must never stand in for employer posting dates.

## Research

- [Google's JavaScript SEO guidance](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics): server rendering helps users and crawlers; return real status codes and expose content without requiring client execution.
- [Crawlable links](https://developers.google.com/search/docs/crawling-indexing/links-crawlable): use anchors with real `href` values and descriptive text.
- [Canonical URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls): align internal links, canonical annotations, and sitemap URLs.
- [JobPosting requirements](https://developers.google.com/search/docs/appearance/structured-data/job-posting): markup belongs on individual jobs with full descriptions; remove or expire closed postings promptly.
- [Helpful content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content): answer a student's actual questions, without mass-producing pages for ranking.
- [Cloudflare Pages advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/) and [routing](https://developers.cloudflare.com/pages/functions/routing/): ship the renderer with the web artifact and scope Function invocation to dynamic pages.

## Measurement and rollout

Merge through the normal CI-gated Pages deployment. No ingestion flags or database migrations are needed for metadata work.

After deployment, verify response status, content type, canonical, and HTML links with JavaScript disabled. In Google Search Console, submit `https://ntern.app/sitemap.xml`, inspect the homepage and representative public role pages, and record indexing coverage and crawl errors. Compare non-brand impressions, clicks, and queries over the next 28 days with the previous 28 days; track official-application handoffs separately from rankings. Search Console access and indexing outcomes are external follow-up steps, not code validation results.

Do not claim traffic gains before measuring them. Defer backlink campaigns, broad programmatic pages, and content publishing at scale until the existing catalog can be crawled reliably.
