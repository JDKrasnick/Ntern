import { describe, expect, it } from "vitest";
import { addMetadata, metadata, sitemap } from "../scripts/web-seo.mjs";

describe("public web metadata", () => {
  it("replaces the Expo title and uses the production canonical", () => {
    const html = addMetadata('<html><head><title>Ntern</title></head><body><div id="root"></div></body></html>', {
      title: "Technical roles — Ntern", description: 'Find roles & apply "officially".',
    });
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('rel="canonical" href="https://ntern.app/"');
    expect(html).toContain('content="Find roles &amp; apply &quot;officially&quot;."');
    expect(html).toContain('<div id="root"></div>');
  });

  it("escapes catalog text so it cannot create tags or attributes", () => {
    const html = metadata({ title: '</title><script>alert(1)</script>', description: '" onload="bad', path: '/jobs/a&b' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("/jobs/a&amp;b");
  });

  it("lists clean canonical URLs without fabricated modification dates", () => {
    const xml = sitemap(["/", "/privacy", "/terms"]);
    expect(xml).toContain('<loc>https://ntern.app/privacy</loc>');
    expect(xml).not.toContain("lastmod");
    expect(xml).not.toContain(".html");
  });
});
