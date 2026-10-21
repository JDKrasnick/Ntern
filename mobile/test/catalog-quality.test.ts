import { describe, expect, it } from "vitest";
import { boundedCatalogText, catalogMetadataTags, compactCatalogEducation, compactCatalogLocation, compactCatalogTitle, compactLocations, presentCatalogRole, roleSheetTitle, seasonLabel } from "../src/catalog-quality.js";
import { compactCompensationLabel } from "../../shared/compensation-display.js";
import type { PostingFact } from "../../shared/posting-facts.js";

describe("catalog presentation hardening", () => {
  it("summarizes broad degree eligibility while retaining specific and uncertain requirements", () => {
    expect(compactCatalogEducation(['Undergrad', 'Masters', 'PhD'])).toBe('All degree levels');
    expect(compactCatalogEducation(['Masters', 'PhD'])).toBe('Graduate');
    expect(compactCatalogEducation(['Masters', 'MBA', 'PhD'])).toBe('Graduate');
    expect(compactCatalogEducation(['Undergrad', 'Masters', 'MBA', 'PhD'])).toBe('All degree levels');
    expect(compactCatalogEducation(['Undergrad', 'Masters'])).toBe('Undergrad/Masters');
    expect(compactCatalogEducation(['Masters'])).toBe('Masters');
    expect(compactCatalogEducation(['MBA'])).toBe('MBA');
    expect(compactCatalogEducation(['Pursuing degree'])).toBe('All degree levels');
    expect(compactCatalogEducation(['Not specified'])).toBe('Not specified');
    expect(compactCatalogEducation(['Masters (inferred)', 'PhD (inferred)'])).toBe('Graduate (inferred)');
    expect(compactCatalogEducation(['Masters', 'PhD (inferred)'])).toBe('Masters/PhD (inferred)');
    expect(compactCatalogEducation(['Undergrad', 'Masters', 'PhD', 'Conflicting sources'])).toBe('Undergrad/Masters/PhD/Conflicting sources');
  });
  it("keeps a stated degree requirement visible when its level is unspecified", () => {
    const facts: PostingFact[] = [{ field: 'education', statements: ['Working towards advanced degree in quantitative field (economics, finance, CS or applied math)'], qualifiers: [], sourceUrl: 'https://example.com/job', contentHash: 'a'.repeat(64) }];
    const unspecified = [{ levels: [], evidence: 'unspecified' }];
    expect(catalogMetadataTags([], unspecified, facts)).toContainEqual({ label: 'Pursuing degree', kind: 'education' });
    expect(catalogMetadataTags([], unspecified, facts)).not.toContainEqual({ label: 'Education unspecified', kind: 'neutral' });
    expect(catalogMetadataTags([], unspecified)).toContainEqual({ label: 'Education unspecified', kind: 'neutral' });
    expect(catalogMetadataTags([], [{ levels: ['masters'], evidence: 'explicit' }], facts)).not.toContainEqual({ label: 'Pursuing degree', kind: 'education' });
    expect(catalogMetadataTags([], [{ levels: [], evidence: 'conflicting' }], facts)).toContainEqual({ label: 'Education unclear', kind: 'neutral' });
  });
  it("shows season and education tags without turning missing or inferred evidence into requirements", () => {
    expect(catalogMetadataTags(['summer-2027'], [{ levels: ['undergraduate', 'masters'], evidence: 'explicit' }])).toEqual([
      { label: 'Summer 2027', kind: 'season' }, { label: 'Undergrad', kind: 'education' }, { label: 'Masters', kind: 'education' },
    ]);
    expect(catalogMetadataTags(['ongoing'], [{ levels: ['doctoral'], evidence: 'inferred' }])).toEqual([
      { label: 'Season unspecified', kind: 'neutral' }, { label: 'PhD (inferred)', kind: 'education' },
    ]);
    expect(catalogMetadataTags([], [{ levels: ['undergraduate'], evidence: 'unspecified' }])).toEqual([
      { label: 'Season unspecified', kind: 'neutral' }, { label: 'Education unspecified', kind: 'neutral' },
    ]);
    expect(catalogMetadataTags(['Fall 2027', 'Fall 2027'], [{ levels: ['masters'], evidence: 'conflicting' }])).toEqual([
      { label: 'Fall 2027', kind: 'season' }, { label: 'Education unclear', kind: 'neutral' },
    ]);
  });
  it("shows the term once in the role sheet title", () => {
    expect(roleSheetTitle("Hardware Intern [Winter 2027]", "winter-2027")).toBe("Hardware Intern [Winter 2027]");
    expect(roleSheetTitle("Hardware Intern", "winter-2027")).toBe("Hardware Intern · Winter 2027");
    expect(roleSheetTitle("Hardware Intern", "ongoing")).toBe("Hardware Intern");
    expect(roleSheetTitle("Hardware Intern", undefined)).toBe("Hardware Intern");
  });
  it("uses explicit currency, period and applicability on every role surface", () => {
    const role = { compensation: { raw: "legacy", ranges: [
      { minAmount: 2000, maxAmount: 4000, currency: "JPY", period: "hourly", applicableLocations: ["Tokyo"] },
      { minAmount: 123500, maxAmount: 170000, currency: "USD", period: "unknown", applicableLocations: ["New York"] },
      { minAmount: 3500, maxAmount: 5700, currency: "USD", period: "weekly" },
    ] } };
    expect(presentCatalogRole(role).compensation).toBe("JPY 2,000–4,000/hour (Tokyo) · USD 123,500–170,000 · period not stated (New York) · USD 3,500–5,700/week");
    expect(presentCatalogRole({ compensation: { raw: "" } }).compensation).toBe("");
  });
  it("bounds legacy API and cache values without splitting emoji", () => {
    const value = `👩🏽‍💻 ${"engineer ".repeat(80)}`;
    expect([...boundedCatalogText(value, 40)].length).toBeLessThanOrEqual(40);
    expect([...boundedCatalogText("开发工程师".repeat(100), 12)].length).toBe(12);
  });

  it("summarizes at most twelve locations", () => {
    const locations = Array.from({ length: 15 }, (_, index) => `Location ${index + 1}`);
    expect(compactLocations(locations)).toBe("Location 1 · Location 2 + 10 more");
  });

  it("keeps compact cards to a stable role and location summary", () => {
    expect(compactCatalogTitle("Market Analysis Intern - Computer science/data analytics")).toBe("Market Analysis Intern - Computer science/data analytics");
    expect(compactCatalogTitle("Data & AI Internship Program - She/He/They with an unusually long eligibility suffix")).toMatch(/…$/u);
    expect(compactCatalogLocation(["Katowice, Silesia Business Park Bldg C, Poland", "Remote — US"])).toBe("Katowice, Poland");
    expect(compactCatalogLocation(["China, Beijing, China"])).toBe("Beijing, China");
    expect(compactCatalogLocation(["US-IL-Niles"])).toBe("US-IL-Niles");
  });

  it("uses bounded values for visible and accessibility copy", () => {
    const role = presentCatalogRole({ company: "A".repeat(300), title: "منصب ".repeat(100), location: "Remote", season: "ongoing", compensation: { raw: "$50/hr ".repeat(50) } });
    expect([...role.company].length).toBe(160);
    expect([...role.title].length).toBeLessThanOrEqual(240);
    expect([...role.compensation].length).toBeLessThanOrEqual(160);
    expect(role.season).toBe("Season not specified");
    expect(seasonLabel("")).toBe("Season not specified");
  });

  it("removes stale unknown-currency copy from raw compensation", () => {
    const role = presentCatalogRole({ compensation: { raw: "Currency not stated 54/hour" } });
    expect(role.compensation).toBe("54/hour");
  });

  it("formats structured compensation with explicit and source currencies", () => {
    expect(presentCatalogRole({ compensation: { ranges: [{ minAmount: 40, maxAmount: 50, currency: "USD", period: "hourly", sourceText: "$40-$50/hour" }] } }).compensation).toBe("USD 40–50/hour");
    expect(presentCatalogRole({ compensation: { ranges: [{ minAmount: 20, maxAmount: 20, currency: "XXX", period: "hourly", sourceText: "£20/hour" }] } }).compensation).toBe("£20/hour");
  });

  it("keeps role-row pay disclosures short while details retain every range", () => {
    expect(compactCompensationLabel({ ranges: [{ minAmount: 95_000, maxAmount: 110_000, currency: "USD", period: "unknown", applicableEducationLevels: ["undergraduate, masters, doctoral"] }] })).toBe("$95K–$110K");
    expect(compactCompensationLabel({ ranges: [{ minAmount: 45, maxAmount: 55, currency: "USD", period: "hourly" }] })).toBe("$45–$55/hr");
    expect(compactCompensationLabel({ ranges: [{ minAmount: 20, maxAmount: 20, currency: "EUR", period: "monthly" }, { minAmount: 25, maxAmount: 25, currency: "EUR", period: "monthly" }] })).toBe("Pay varies");
  });
});
