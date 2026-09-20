import { describe, expect, it } from "vitest";
import { catalogGridColumnCount } from "../src/catalog-layout";

describe("catalogGridColumnCount", () => {
  it.each([
    [390, 1],
    [560, 2],
    [839, 2],
    [840, 4],
    [1099, 4],
    [1100, 5],
    [1440, 5],
    [1680, 5],
    [1800, 5],
  ])("maps %ipx to %i columns", (width, columns) => {
    expect(catalogGridColumnCount(width)).toBe(columns);
  });
});
