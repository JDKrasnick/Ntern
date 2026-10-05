import { describe, expect, it } from "vitest";
import { topics } from "../web/topics.mjs";
import { createPublicWorker } from "../web/public-worker.mjs";

describe("curated role searches", () => {
  it("keeps senior and graduate roles out of internship searches", () => {
    expect(topics.software.matches({ title: "Senior Software Engineer" })).toBe(false);
    expect(topics.software.matches({ title: "Software Engineer Intern", programType: "new-grad" })).toBe(false);
    expect(topics.software.matches({ title: "Software Engineer Intern" })).toBe(true);
    expect(topics.ml.matches({ title: "Machine Learning Engineer", programType: "internship" })).toBe(true);
    expect(topics.ml.matches({ title: "Machine Learning Engineer", programType: "new-grad" })).toBe(false);
  });

  it("does not classify graduate research internships as new-grad employment", () => {
    expect(topics.graduate.matches({ title: "Graduate Research Intern", programType: "internship" })).toBe(false);
    expect(topics.graduate.matches({ title: "New Graduate Engineer" })).toBe(true);
    expect(topics.graduate.matches({ title: "Graduate Engineer", programType: "new-grad" })).toBe(true);
  });

  it("filters live results and preserves the topic in continuation links", async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return Response.json({ scanBudget: 100, cursor: "100", jobs: [
        { jobId: "intern", title: "Software Engineer Intern", company: "Acme", open: true, applyUrl: "https://careers.example.com/intern", programType: "internship" },
        { jobId: "senior", title: "Senior Software Engineer", company: "Acme", open: true, applyUrl: "https://careers.example.com/senior" },
      ] });
    };
    try {
      const worker = createPublicWorker("https://intern-notifs.jdkrasnick.workers.dev");
      const result = await worker.fetch(new Request("https://ntern.app/jobs?topic=software"), {});
      const html = await result.text();
      expect(html).toContain('href="/jobs/intern"');
      expect(html).not.toContain('href="/jobs/senior"');
      expect(html).toContain('href="/jobs?topic=software&amp;cursor=100"');
      expect(html).toContain('rel="canonical" href="https://ntern.app/internships/software-engineering"');
      expect(html).toContain('content="noindex, follow"');
      expect(calls[0]).toContain("scan=bounded");
      expect(calls[0]).toContain("q=software");
      expect((await worker.fetch(new Request("https://ntern.app/jobs?topic=__proto__"), {})).status).toBe(400);
      expect(calls).toHaveLength(1);
    } finally { globalThis.fetch = original; }
  });
});
