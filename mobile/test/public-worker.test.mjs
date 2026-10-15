import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicWorker } from "../web/public-worker.mjs";

const apiOrigin = "https://intern-notifs.jdkrasnick.workers.dev";
const worker = createPublicWorker(apiOrigin);
const job = { jobId: "abc123", title: "Software Engineer Intern", company: "Example", location: "New York",
  open: true, applyUrl: "https://careers.example.com/abc123", programType: "internship",
  sourceReferences: [{ state: "open", provenance: "official-ats" }] };
const env = { ASSETS: { fetch: vi.fn(() => new Response("app asset")) } };
const request = (path, options) => new Request(`https://ntern.app${path}`, options);
const api = (data, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => Response.json(data, { status })));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("public role renderer", () => {
  it("uses native disclosure controls and caps expanded pay choices at three", async () => {
    api({ ...job, compensation: { ranges: [37, 42, 50, 60].map(amount => ({ minAmount: amount, maxAmount: amount, currency: "USD", period: "hourly" })) } });
    const html = await (await worker.fetch(request("/jobs/abc123"), env)).text();
    expect(html).toContain('<summary aria-label="Pay: Pay varies">');
    expect(html).toContain('<li>USD 37/hour</li><li>USD 42/hour</li><li>USD 50/hour</li>');
    expect(html).not.toContain('USD 60/hour');
    expect(html).not.toContain('Pay disclosed');
    expect(html).toContain('More pay options on the employer’s site.');
    expect(html).not.toContain('<details class="fact-disclosure" open');
  });
  it("shows all published posting facts and escapes their statements and qualifiers", async () => {
    const fields = ["compensation", "locations", "workMode", "housing", "timing", "education", "eligibility"];
    api({ ...job, postingFacts: fields.map(field => ({ field, statements: [`${field}: <script>unsafe</script>`], qualifiers: ["Only if eligible & enrolled"], sourceUrl: job.applyUrl, contentHash: "a".repeat(64) })) });
    const html = await (await worker.fetch(request("/jobs/abc123"), env)).text();
    for (const field of fields) expect(html).toContain(`${field}: &lt;script&gt;unsafe&lt;/script&gt;`);
    expect(html).toContain("Only if eligible &amp; enrolled");
    expect(html).not.toContain("<script>");
    expect(html).toContain('<dt>Housing</dt><dd><details class="fact-disclosure">');
    expect(html.match(/<dt>Location<\/dt>/g)).toHaveLength(1);
    expect(html).toContain('<p>Only if eligible &amp; enrolled</p>');
  });
  it("serves the same HTML to visitors and bots, with source labels and a safe handoff", async () => {
    api(job);
    const browser = await worker.fetch(request("/jobs/abc123"), env);
    const crawler = await worker.fetch(request("/jobs/abc123", { headers: { "User-Agent": "Googlebot" } }), env);
    expect(await browser.text()).toBe(await crawler.text());
    const result = await worker.fetch(request("/jobs/abc123"), env);
    const html = await result.text();
    expect(html).toContain('href="https://careers.example.com/abc123"');
    expect(html).toContain("Employer posted");
    expect(html).toContain("not the full job description");
    expect(html).not.toContain("JobPosting");
    expect(result.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("uses real missing, closed, failure, and malformed-id statuses", async () => {
    api({}, 404);
    expect((await worker.fetch(request("/jobs/abc123"), env)).status).toBe(404);
    api({ ...job, open: false });
    const closed = await worker.fetch(request("/jobs/abc123"), env);
    expect(closed.status).toBe(410);
    expect(await closed.text()).not.toContain(job.applyUrl);
    api({ ...job, open: true, season: "summer-2020" });
    expect((await worker.fetch(request("/jobs/abc123"), env)).status).toBe(410);
    api({}, 500);
    const failed = await worker.fetch(request("/jobs/abc123"), env);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect(failed.headers.get("Retry-After")).toBe("60");
    fetch.mockClear();
    expect((await worker.fetch(request("/jobs/%3Cscript%3E"), env)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("escapes untrusted catalog facts and rejects unsafe or mismatched destinations", async () => {
    api({ ...job, title: '<script>alert("x")</script>', company: '" onload="bad' });
    const html = await (await worker.fetch(request("/jobs/abc123"), env)).text();
    expect(html).not.toContain("<script>");

    expect(html).toContain("&lt;script&gt;");
    api({ ...job, applyUrl: "javascript:alert(1)" });
    expect((await worker.fetch(request("/jobs/abc123"), env)).status).toBe(503);
    api({ ...job, jobId: "different" });
    expect((await worker.fetch(request("/jobs/abc123"), env)).status).toBe(503);
  });

  it("paginates with anchors and limits sitemap reads to 50 open roles", async () => {
    api({ jobs: [job, { ...job, jobId: "closed", open: false }], cursor: "25", scanBudget: 100 });
    const first = await (await worker.fetch(request("/jobs"), env)).text();
    expect(first).toContain('href="/jobs/abc123"');
    expect(first).toContain('href="/jobs?cursor=25"');
    expect(first).not.toContain('href="/jobs/closed"');
    expect(fetch).toHaveBeenCalledWith(`${apiOrigin}/jobs?status=open&scan=bounded&limit=25`, expect.anything());
    const next = await (await worker.fetch(request("/jobs?cursor=25"), env)).text();
    expect(next).toContain('content="noindex, follow"');
    expect(next).not.toContain('href="/jobs?cursor=25"');
    const xml = await (await worker.fetch(request("/sitemap.xml"), env)).text();
    expect(xml).toContain("<loc>https://ntern.app/jobs/abc123</loc>");
    expect(xml).not.toContain("/jobs/closed");
    expect(fetch).toHaveBeenLastCalledWith(`${apiOrigin}/jobs?status=open&scan=bounded&limit=50`, expect.anything());
  });

  it("does not let arbitrary queries or methods drive catalog scans", async () => {
    const redirect = await worker.fetch(request("/jobs?utm_source=search"), env);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("Location")).toBe("https://ntern.app/jobs");
    expect((await worker.fetch(request("/jobs?cursor=99999999"), env)).status).toBe(400);
    const post = await worker.fetch(request("/jobs", { method: "POST" }), env);
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("fails closed when the API has not deployed bounded scan support", async () => {
    api({ jobs: [job] });
    expect((await worker.fetch(request("/jobs"), env)).status).toBe(503);
    api({ jobs: [job], scanBudget: 100 });
    expect((await worker.fetch(request("/jobs"), env)).status).toBe(200);
  });

  it("keeps preview pages out of search and HEAD responses bodyless", async () => {
    api(job);
    const preview = await worker.fetch(new Request("https://seo-preview.internnotifs.pages.dev/jobs/abc123"), env);
    expect(preview.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(await preview.text()).toContain('href="https://ntern.app/jobs/abc123"');
    const head = await worker.fetch(request("/jobs/abc123", { method: "HEAD" }), env);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("caps response bytes even when the API omits Content-Length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024 + 1), {
      headers: { "Content-Type": "application/json" },
    })));
    expect((await worker.fetch(request("/jobs"), env)).status).toBe(503);
  });

  it("reuses a cached public page without forwarding visitor credentials", async () => {
    api(job);
    const entries = new Map();
    const cache = { match: vi.fn(async (key) => entries.get(key.url)?.clone()),
      put: vi.fn(async (key, value) => { entries.set(key.url, value); }) };
    vi.stubGlobal("caches", { default: cache });
    const pending = [];
    const ctx = { waitUntil: (task) => pending.push(task) };
    await worker.fetch(request("/jobs/abc123", { headers: { Cookie: "private", Authorization: "Bearer private" } }), env, ctx);
    await Promise.all(pending);
    await worker.fetch(request("/jobs/abc123"), env, ctx);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers).toEqual({ Accept: "application/json" });
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("delegates app and asset paths without invoking the catalog API", async () => {
    expect(await (await worker.fetch(request("/?job=abc123"), env)).text()).toBe("app asset");
    expect(await (await worker.fetch(request("/policy.css"), env)).text()).toBe("app asset");
    expect(() => createPublicWorker("https://attacker.example")).toThrow("Unapproved");
  });
});
