import { describe, expect, it } from "vitest";
import { boundedCatalogText, compactCatalogLocation, compactCatalogTitle, compactLocations, presentCatalogRole, seasonLabel } from "../src/catalog-quality.js";
import { compactCompensationLabel } from "../../shared/compensation-display.js";

describe("catalog presentation hardening", () => {
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
