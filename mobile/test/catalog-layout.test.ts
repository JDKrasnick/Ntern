import { describe, expect, it } from "vitest";
import {
  catalogGroupHasNewRole,
  catalogGroupsForFreshness,
  catalogListUsesColumns,
  catalogNewRoleCount,
} from "../src/catalog-layout";

describe("catalogListUsesColumns", () => {
  it.each([
    [320, false],
    [390, false],
    [699, false],
    [899, false],
    [900, true],
    [1120, true],
    [1440, true],
  ])("maps %ipx to comparison columns: %s", (width, expected) => {
    expect(catalogListUsesColumns(width)).toBe(expected);
  });
});

describe("catalog freshness lens", () => {
  const now = new Date("2026-09-30T16:00:00.000Z").valueOf();
  const groups = [
    { groupId: "alpha", roleIds: ["role-1", "role-2"], updatedAt: "2026-09-30T10:00:00.000Z" },
    { groupId: "beta", roleIds: ["role-3"], updatedAt: "2026-09-27T10:00:00.000Z" },
    { groupId: "gamma", roleIds: [], updatedAt: "2026-09-20T10:00:00.000Z" },
  ];
  const newJobIds = new Set(["role-2", "role-3", "not-visible"]);

  it("recognizes a group when any contained role is new", () => {
    expect(catalogGroupHasNewRole(groups[0], newJobIds)).toBe(true);
    expect(catalogGroupHasNewRole(groups[2], newJobIds)).toBe(false);
  });

  it("counts visible new roles without counting ids outside the current view", () => {
    expect(catalogNewRoleCount(groups, newJobIds)).toBe(2);
  });

  it("keeps the whole list for All and narrows it for New", () => {
    expect(catalogGroupsForFreshness(groups, newJobIds, "all", now)).toEqual(groups);
    expect(catalogGroupsForFreshness(groups, newJobIds, "new", now).map((group) => group.groupId)).toEqual(["alpha", "beta"]);
  });

  it("uses rolling 24-hour and seven-day windows", () => {
    expect(catalogGroupsForFreshness(groups, newJobIds, "day", now).map((group) => group.groupId)).toEqual(["alpha"]);
    expect(catalogGroupsForFreshness(groups, newJobIds, "week", now).map((group) => group.groupId)).toEqual(["alpha", "beta"]);
  });
});
