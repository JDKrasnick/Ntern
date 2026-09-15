import { describe, expect, it } from "vitest";
import {
  directSubmissionPayload,
  employerRouteFromUrl,
  employerStateExplanation,
  metadataProposalPayload,
  sourceConnectionPayload,
} from "../src/employer.js";

describe("employer web routes", () => {
  it("routes only the dedicated employer path", () => {
    expect(employerRouteFromUrl("https://ntern.app/employer")).toBe("verification");
    expect(employerRouteFromUrl("/employer/sources?from=email")).toBe("sources");
    expect(employerRouteFromUrl("/employer/submissions/")).toBe("submissions");
    expect(employerRouteFromUrl("/employer/sources/unexpected")).toBeUndefined();
    expect(employerRouteFromUrl("/jobs/role-1")).toBeUndefined();
  });

  it("falls back safely for an unknown employer section", () => {
    expect(employerRouteFromUrl("/employer/not-a-screen")).toBe("verification");
  });
});

describe("employer status explanations", () => {
  it.each(["rejected", "stale", "disconnected", "quarantined", "expired", "revoked"] as const)(
    "gives %s a reason slot and concrete recovery action",
    (state) => {
      const explanation = employerStateExplanation(state, "Evidence did not match.");
      expect(explanation.reason).toBe("Evidence did not match.");
      expect(explanation.nextAction).toBeTruthy();
      expect(["warning", "danger"]).toContain(explanation.tone);
    },
  );

  it("does not invent a recovery step for a healthy state", () => {
    expect(employerStateExplanation("active")).toEqual({ label: "Active", tone: "positive", reason: undefined });
  });

  it("keeps failure states actionable when the API has no specific diagnostic", () => {
    const explanation = employerStateExplanation("disconnected");
    expect(explanation.reason).toContain("cannot reach");
    expect(explanation.nextAction).toContain("reconnect");
  });
});

describe("employer request payloads", () => {
  it("normalizes source and field proposals", () => {
    expect(sourceConnectionPayload("  https://boards.greenhouse.io/acme  ")).toEqual({ url: "https://boards.greenhouse.io/acme" });
    expect(metadataProposalPayload(" role-1 ", " deadline ", " rolling ")).toEqual({
      jobId: "role-1",
      field: "deadline",
      proposedValue: "rolling",
    });
  });

  it("keeps direct submissions structured and omits blank optional values", () => {
    expect(directSubmissionPayload({
      company: " Acme ",
      title: " SWE Intern ",
      programType: " internship ",
      discipline: " software engineering ",
      location: " Remote ",
      workMode: " remote ",
      season: " Summer 2027 ",
      deadline: " rolling ",
      deadlineTimezone: " ",
      workAuthorization: " unknown ",
      applicationUrl: " https://acme.com/apply ",
      privateReviewNote: " ",
    })).toEqual({
      company: "Acme",
      title: "SWE Intern",
      programType: "internship",
      discipline: "software engineering",
      location: "Remote",
      workMode: "remote",
      season: "Summer 2027",
      deadline: "rolling",
      workAuthorization: "unknown",
      applicationUrl: "https://acme.com/apply",
      submit: true,
    });
  });
});
