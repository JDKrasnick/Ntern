import { describe, expect, it } from "vitest";
import { proactivePrefetchFraction, shouldPrefetchNextPage } from "../src/infinite-scroll";

const scrolled = (contentOffsetY: number) => ({
  contentOffsetY,
  contentHeight: 4000,
  viewportHeight: 1000,
  loading: false,
  reachedEnd: false,
  errored: false,
});

describe("shouldPrefetchNextPage", () => {
  it("waits until the reader is halfway through the loaded content", () => {
    // Scrollable length is 3000, so the midpoint is 1500.
    expect(shouldPrefetchNextPage(scrolled(1400))).toBe(false);
    expect(shouldPrefetchNextPage(scrolled(1500))).toBe(true);
    expect(shouldPrefetchNextPage(scrolled(2600))).toBe(true);
  });

  it("honours an explicit fraction", () => {
    expect(shouldPrefetchNextPage({ ...scrolled(900), fraction: 0.3 })).toBe(true);
    expect(shouldPrefetchNextPage({ ...scrolled(800), fraction: 0.3 })).toBe(false);
  });

  it("never prefetches while a page is already loading", () => {
    expect(shouldPrefetchNextPage({ ...scrolled(3900), loading: true })).toBe(false);
  });

  it("never prefetches past the end", () => {
    expect(shouldPrefetchNextPage({ ...scrolled(3900), reachedEnd: true })).toBe(false);
  });

  it("lets a failed page rest until the reader retries", () => {
    expect(shouldPrefetchNextPage({ ...scrolled(3900), errored: true })).toBe(false);
  });

  it("keeps filling a list shorter than the viewport", () => {
    expect(shouldPrefetchNextPage({ ...scrolled(0), contentHeight: 600 })).toBe(true);
  });

  it("uses a half-page default fraction", () => {
    expect(proactivePrefetchFraction).toBe(0.5);
  });
});
