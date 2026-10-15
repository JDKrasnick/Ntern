import { page } from "./public-page.mjs";
import { escapeHtml, policyDescriptions, sitemap } from "../scripts/web-seo.mjs";
import { isPastSeason } from "../../src/core/early-career.ts";
import { topicLinks, topics } from "./topics.mjs";
import { postingFactSummaries } from "../../shared/posting-fact-display.ts";

const approvedOrigins = new Set([
  "https://intern-notifs.jdkrasnick.workers.dev",
  "https://intern-notifs-dev.jdkrasnick.workers.dev",
]);
const maxApiBytes = 2 * 1024 * 1024;
const roleIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const maxCursor = 10000;

export { page };

function response(body, status = 200, contentType = "text/html; charset=utf-8", ttl = 300) {
  return new Response(body, { status, headers: {
    "Content-Type": contentType,
    "Cache-Control": status === 200 ? `public, max-age=0, s-maxage=${ttl}` : "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    ...(status !== 200 ? { "X-Robots-Tag": "noindex" } : {}),
    ...(status === 503 ? { "Retry-After": "60" } : {}),
  } });
}

function problem(status, title, message) {
  return response(page({ title: `${title} — Ntern`, description: message, path: "/jobs", noindex: true,
    body: `<h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(message)}</p><a class="primary" href="/jobs">Browse open roles</a>`,
  }), status);
}

function validRole(job) {
  return job && typeof job.jobId === "string" && roleIdPattern.test(job.jobId) && typeof job.title === "string" && job.title.length > 0
    && typeof job.company === "string" && job.company.length > 0 && typeof job.open === "boolean";
}

function applyUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function roleList(jobs) {
  return `<ul class="roles">${jobs.map((job) => `<li><a href="/jobs/${encodeURIComponent(job.jobId)}">${escapeHtml(job.title)}</a>
    <p>${escapeHtml(job.company)}${job.location ? ` · ${escapeHtml(job.location)}` : ""}</p></li>`).join("")}</ul>`;
}

async function apiJson(apiOrigin, path) {
  // Timeout covers headers AND body. Never forward visitor cookies or credentials.
  const result = await fetch(`${apiOrigin}${path}`, { headers: { Accept: "application/json" },
    redirect: "manual", signal: AbortSignal.timeout(8000) });
  if (result.status === 404) { await result.body?.cancel(); return undefined; }
  if (!result.ok || !result.headers.get("Content-Type")?.includes("application/json")
    || Number(result.headers.get("Content-Length")) > maxApiBytes) {
    await result.body?.cancel();
    throw new Error("Public catalog API unavailable");
  }
  const reader = result.body?.getReader();
  if (!reader) throw new Error("Empty catalog response");
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxApiBytes) throw new Error("Catalog response too large");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(buffer));
}

async function jobsPage(apiOrigin, cursor = "0", limit = 25, topic) {
  const data = await apiJson(apiOrigin, `/jobs?status=open&scan=bounded&limit=${limit}${cursor !== "0" ? `&cursor=${cursor}` : ""}${topic ? `&q=${encodeURIComponent(topic.query)}` : ""}`);
  if (!data || data.scanBudget !== 100 || !Array.isArray(data.jobs) || data.jobs.length > limit || data.jobs.some((job) => !validRole(job))) {
    throw new Error("Invalid catalog page");
  }
  return { jobs: data.jobs.filter((job) => job.open && applyUrl(job.applyUrl) && (!topic || topic.matches(job))),
    cursor: typeof data.cursor === "string" && /^\d{1,5}$/.test(data.cursor)
      && Number(data.cursor) > Number(cursor) && Number(data.cursor) <= maxCursor ? data.cursor : undefined };
}

async function render(request, apiOrigin) {
  const url = new URL(request.url);
  if (url.pathname === "/sitemap.xml") {
    const { jobs } = await jobsPage(apiOrigin, "0", 50);
    return response(sitemap(["/", "/about", "/jobs", ...Object.keys(policyDescriptions).map((slug) => `/${slug}`), ...Object.values(topics).map((topic) => topic.path),
      ...jobs.map((job) => `/jobs/${job.jobId}`)]), 200, "application/xml; charset=utf-8");
  }
  if (url.pathname === "/jobs") {
    const topicKey = url.searchParams.get("topic");
    const topic = topicKey && Object.hasOwn(topics, topicKey) ? topics[topicKey] : undefined;
    if (topicKey && !topic) return problem(400, "Unknown role category", "Choose a category from the role directory.");
    const cursor = url.searchParams.get("cursor") ?? "0";
    if (!/^(0|[1-9]\d{0,4})$/.test(cursor) || Number(cursor) > maxCursor) {
      return problem(400, "Invalid role page", "Choose a page using the next-page link in the role list.");
    }
    const { jobs, cursor: next } = await jobsPage(apiOrigin, cursor, 25, topic);
    const nextParams = new URLSearchParams(topicKey ? { topic: topicKey } : {});
    if (next) nextParams.set("cursor", next);
    return response(page({ title: `${topic?.title ?? "Technical internships and entry-level roles"} — Ntern`, path: topic?.path ?? "/jobs",
      description: "Browse open technical internships, co-ops, and entry-level roles. Learn how Ntern finds opportunities and takes you to official employer applications.",
      noindex: cursor !== "0" || Boolean(topic),
      body: `<h1>${topic?.title ?? "Find your next technical role."}</h1><p class="lede">Ntern is a free early-career radar for students and new graduates. Find technical internships, co-ops, apprenticeships, and entry-level opportunities without refreshing dozens of career sites.</p>
      <a class="primary" href="/">Open Ntern</a><h2>How Ntern works</h2>
      <p>Browse without an account. Ntern brings together reviewed employer career feeds and attributed community sources, with source labels so you can see where a listing came from. Applications always open on the employer’s official site, where you review the full requirements and submit yourself.</p>
      <p>The app lets you set role preferences and device alerts without signing in. Create an account when you want to sync saved applications or store a résumé or profile.</p>
      ${!topic ? `<h2>Explore by role</h2>${topicLinks()}` : ""}
      <h2>Open roles${cursor !== "0" ? " · continued" : ""}</h2>${jobs.length ? roleList(jobs) : '<p>No matching roles are available on this page. Continue to the next page if available, or <a href="/jobs">browse all roles</a>.</p>'}
      <div class="pagination">${cursor !== "0" ? `<a href="/jobs${topicKey ? `?topic=${topicKey}` : ""}">Newest roles</a>` : ""}${next ? `<a href="/jobs?${escapeHtml(nextParams.toString())}">Next roles</a>` : ""}</div>`,
    }));
  }
  const match = /^\/jobs\/([^/]+)$/.exec(url.pathname);
  if (!match || !roleIdPattern.test(match[1])) return problem(404, "Role not found", "This role is not in the public catalog. Browse the current open roles.");
  const job = await apiJson(apiOrigin, `/jobs/${match[1]}`);
  if (!job) return problem(404, "Role not found", "This role is not in the public catalog. Browse the current open roles.");
  if (!validRole(job) || job.jobId !== match[1]) throw new Error("Invalid role response");
  if (!job.open || isPastSeason(job.season ?? "ongoing")) return problem(410, "This role has closed", "Ntern no longer lists this role as open. Browse current opportunities instead.");
  const officialUrl = applyUrl(job.applyUrl);
  if (!officialUrl) throw new Error("Missing safe official application link");
  const title = `${job.title} at ${job.company}`;
  const description = `${title}${job.location ? ` in ${job.location}` : ""}. View the role summary and apply on the employer’s official site with Ntern.`;
  const sourceLabel = job.sourceReferences?.some((source) => source.state === "open" && source.provenance === "employer-submitted") ? "Employer submitted"
    : job.sourceReferences?.some((source) => source.state === "open" && ["official-ats", "official-structured"].includes(source.provenance)) ? "Employer posted" : "Source reported";
  const publishedFacts = postingFactSummaries((Array.isArray(job.postingFacts) ? job.postingFacts : []).filter(fact =>
    fact && Array.isArray(fact.statements) && fact.statements.every(value => typeof value === "string")
    && Array.isArray(fact.qualifiers) && fact.qualifiers.every(value => typeof value === "string")),
    { compensation: job.compensation, housing: job.housing });
  const facts = [["Company", [job.company]],
    ...(job.location && !/^(?:not specified|not stated|unknown|location not specified)$/iu.test(job.location)
      && !publishedFacts.some(fact => fact.field === "locations") ? [["Location", [job.location]]] : []),
    ...(job.programType ? [["Program", [job.programType]]] : []),
    ...(job.workMode && job.workMode !== "unspecified" && !publishedFacts.some(fact => fact.field === "workMode") ? [["Work mode", [job.workMode]]] : []),
    ...publishedFacts.map(fact => [fact.label, fact.tags, fact]), ["Source", [sourceLabel]]];
  const factHtml = facts.map(([label, tags, disclosure]) => {
    const value = `<span class="fact-value">${tags.map(escapeHtml).join(" · ")}</span>`;
    if (!disclosure) return `<div class="fact-row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
    const pay = disclosure.payOptions.length ? `<ul>${disclosure.payOptions.map(option => `<li>${escapeHtml(option)}</li>`).join("")}</ul>` : "";
    const details = disclosure.details.map(detail => `<p>${escapeHtml(detail)}</p>`).join("");
    return `<div class="fact-row"><dt>${escapeHtml(label)}</dt><dd><details class="fact-disclosure"><summary aria-label="${escapeHtml(`${label}: ${tags.join(', ')}`)}">${value}<svg class="fact-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></summary><div class="fact-detail">${pay}${details}${disclosure.morePayOptions ? '<p>More pay options on the employer’s site.</p>' : ''}</div></details></dd></div>`;
  }).join("");
  return response(page({ title: `${title} — Ntern`, description, path: `/jobs/${job.jobId}`,
    body: `<h1>${escapeHtml(job.title)}</h1><p class="lede">${escapeHtml(job.company)}${job.location ? ` · ${escapeHtml(job.location)}` : ""}</p>
      <a class="primary" href="${escapeHtml(officialUrl)}" rel="external noreferrer">Apply on the employer’s site</a>
      <dl class="facts">${factHtml}</dl>
      <h2>Before you apply</h2><p>This is a catalog summary, not the full job description. Check the employer’s page for current requirements, deadlines, pay, and work authorization. An open listing does not guarantee eligibility or visa sponsorship.</p>
      <h2>Why Ntern?</h2><p>Ntern helps students and new graduates discover credible technical roles in one calm, free catalog. Browse without an account, see where each listing came from, and choose when to apply. Ntern does not submit applications for you.</p>
      <p><a href="/?job=${encodeURIComponent(job.jobId)}">View this role in the Ntern app</a> to save it or explore the catalog. <a href="/source-policy">Read about our sources and corrections.</a></p>`,
  }), 200, "text/html; charset=utf-8", 60);
}

export function createPublicWorker(apiOrigin) {
  if (!approvedOrigins.has(apiOrigin)) throw new Error("Unapproved public API origin");
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const handled = url.pathname === "/jobs" || url.pathname.startsWith("/jobs/") || url.pathname === "/sitemap.xml";
      if (!handled) return env.ASSETS.fetch(request);
      if (!["GET", "HEAD"].includes(request.method)) {
        const result = problem(405, "Method not allowed", "Use a GET request to browse public roles.");
        result.headers.set("Allow", "GET, HEAD"); return result;
      }
      if (url.pathname !== "/jobs") url.search = "";
      else {
        const cursor = url.searchParams.get("cursor");
        const topic = url.searchParams.get("topic");
        url.search = "";
        if (topic) url.searchParams.set("topic", topic);
        if (cursor && cursor !== "0") url.searchParams.set("cursor", cursor);
      }
      if (url.href !== request.url) return new Response(null, { status: 308, headers: { Location: url.href, "Cache-Control": "no-store" } });
      // Version the key so a new renderer never serves HTML from a previous release.
      const cacheUrl = new URL(url); cacheUrl.searchParams.set("__renderer", "PUBLIC_RENDERER_VERSION");
      cacheUrl.searchParams.set("__api", apiOrigin);
      const key = new Request(cacheUrl, { method: "GET" });
      const cache = globalThis.caches?.default;
      let result;
      try {
        result = await cache?.match(key);
        if (!result) {
          result = await render(request, apiOrigin);
          if (url.hostname !== "ntern.app") result.headers.set("X-Robots-Tag", "noindex");
          if (result.status === 200 && cache && ctx) ctx.waitUntil(cache.put(key, result.clone()).catch(() => {}));
        }
      } catch (error) {
        console.error(JSON.stringify({ event: "public_seo_render_failed", path: url.pathname,
          message: error instanceof Error ? error.message : "Unknown error" }));
        result = problem(503, "Roles are temporarily unavailable", "The catalog could not be loaded. Please try again shortly or open the Ntern app.");
      }
      return request.method === "HEAD" ? new Response(null, { status: result.status, headers: result.headers }) : result;
    },
  };
}

export default createPublicWorker(typeof __PUBLIC_API_ORIGIN__ === "string"
  ? __PUBLIC_API_ORIGIN__ : "https://intern-notifs.jdkrasnick.workers.dev");
