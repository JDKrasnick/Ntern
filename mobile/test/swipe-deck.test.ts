import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deckCandidates,
  forgetSeen,
  forgetSkip,
  mergeDeckJobs,
  parseDeckCache,
  parseSeenList,
  parseSkipList,
  rememberSeen,
  rememberSkip,
  resolveSwipe,
  shouldLoadMoreDeck,
  swipeDeckPrefetchFloor,
  swipeSeenCacheKey,
  swipeSkipCacheKey,
  swipeSkipLimit,
} from "../src/swipe-deck";

const role = (jobId: string) => ({ jobId });

describe("resolveSwipe", () => {
  it("queues a confident right drag and skips a confident left drag", () => {
    expect(resolveSwipe({ dx: 140, vx: 0.1, width: 360 })).toBe("queue");
    expect(resolveSwipe({ dx: -140, vx: -0.1, width: 360 })).toBe("skip");
  });

  it("returns the card when a drag does not cross the threshold", () => {
    expect(resolveSwipe({ dx: 20, vx: 0.1, width: 360 })).toBe("none");
    expect(resolveSwipe({ dx: -20, vx: -0.1, width: 360 })).toBe("none");
  });

  it("lets a short flick commit on velocity alone", () => {
    expect(resolveSwipe({ dx: 30, vx: 0.9, width: 360 })).toBe("queue");
    expect(resolveSwipe({ dx: -30, vx: -0.9, width: 360 })).toBe("skip");
  });

  it("scales the distance with the card but keeps it within bounds on a wide screen", () => {
    // A narrow card commits sooner than a fixed 132, but never sooner than 64.
    expect(resolveSwipe({ dx: 70, vx: 0, width: 220 })).toBe("queue");
    expect(resolveSwipe({ dx: 70, vx: 0, width: 80 })).toBe("queue");
    // A very wide card still commits at the cap, not proportionally farther.
    expect(resolveSwipe({ dx: 140, vx: 0, width: 2_000 })).toBe("queue");
    expect(resolveSwipe({ dx: 120, vx: 0, width: 2_000 })).toBe("none");
  });

  it("does not let velocity alone drag a card backward", () => {
    expect(resolveSwipe({ dx: -30, vx: 0.9, width: 360 })).toBe("none");
    expect(resolveSwipe({ dx: 30, vx: -0.9, width: 360 })).toBe("none");
  });
});

describe("swipe motion", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("keeps waiting roles still and removes stamped or popping feedback", () => {
    expect(app).toContain("swipeDeckPeek: { opacity: 1 }");
    expect(app).toContain("swipeDeckFar: { opacity: 1 }");
    expect(app).not.toContain("peekLift");
    expect(app).not.toContain("farLift");
    expect(app).not.toContain("swipeStamp");
    expect(app).not.toContain("queuePulse");
  });

  it("uses a soothing blue-green queue wash and one mirrored release", () => {
    expect(app).toContain("const queueBlueWashOpacity = translateX.interpolate");
    expect(app).toContain("const queueGreenWashOpacity = translateX.interpolate");
    expect(app).toContain("backgroundColor: colors.signalSoft");
    expect(app).toContain("backgroundColor: colors.successSoft");
    expect(app).toContain("borderColor: colors.successBorder");
    expect(app).toContain("Math.min(width, 460) * 0.52");
    expect(app).toContain("toValue: direction * travel, duration: 360");
    expect(app).toContain("toValue: 18, duration: 360");
    expect(app).not.toContain("toValue: direction * -18");
    expect(app).toContain("toValue: direction, duration: 360");
    expect(app).toContain("toValue: 0, duration: 360, easing: Easing.in(Easing.quad)");
  });

  it("keeps drag tracking level, then adds a subtle diagonal release", () => {
    expect(app).not.toContain("gesture.dy * 0.12");
    expect(app).toContain("const exitY = useRef(new Animated.Value(0)).current;");
    expect(app).toContain("const exitRotation = useRef(new Animated.Value(0)).current;");
    expect(app).toContain("toValue: 18, duration: 360");
    expect(app).toContain("outputRange: [\"-4deg\", \"0deg\", \"4deg\"]");
    expect(app).toContain("transform: [{ translateX }, { translateY: exitY }, { rotate: exitRotate }]");
  });

  it("keeps card geometry fixed while feedback appears and reveals the next role after commit", () => {
    expect(app).toContain("<View style={swipeStyles.swipeFeedbackSlot}>");
    expect(app).toContain('swipeFeedbackSlot: { alignItems: "center", height: 52');
    expect(app).toContain("useLayoutEffect(() => {");
    expect(app).toContain("if (!deciding.current) return;");
    expect(app).toContain("initialJobs={latestCatalogJobs}");
    expect(app).toContain("initialJobs={latestJobs}");
    expect(app).toContain("loading: loading || loadingMore");
  });
});

describe("deckCandidates", () => {
  it("drops queued, hidden, and skipped roles and de-duplicates the rest", () => {
    const jobs = [role("a"), role("b"), role("c"), role("a"), role("d")];
    expect(
      deckCandidates(jobs, {
        queued: new Set(["b"]),
        hidden: new Set(["c"]),
        skipped: new Set(["d"]),
      }).map((job) => job.jobId),
    ).toEqual(["a"]);
  });

  it("keeps the server's newest-first order", () => {
    const jobs = [role("newest"), role("middle"), role("oldest")];
    expect(deckCandidates(jobs).map((job) => job.jobId)).toEqual(["newest", "middle", "oldest"]);
  });

  it("is safe with an empty pool", () => {
    expect(deckCandidates([])).toEqual([]);
  });
});

describe("mergeDeckJobs", () => {
  it("keeps the visible order and appends only unseen prefetched roles", () => {
    expect(mergeDeckJobs([role("visible"), role("next")], [role("next"), role("fresh")]))
      .toEqual([role("visible"), role("next"), role("fresh")]);
  });

  it("seeds an empty deck immediately", () => {
    expect(mergeDeckJobs([], [role("first"), role("second")]))
      .toEqual([role("first"), role("second")]);
  });
});

describe("skip memory", () => {
  it("puts the most recent skip first without duplicating", () => {
    expect(rememberSkip(["b", "a"], "a")).toEqual(["a", "b"]);
    expect(rememberSkip(["b", "a"], "c")).toEqual(["c", "b", "a"]);
  });

  it("bounds the list", () => {
    expect(rememberSkip(["a", "b", "c"], "d", 2)).toEqual(["d", "a"]);
  });

  it("forgets a skip", () => {
    expect(forgetSkip(["a", "b", "a"], "a")).toEqual(["b"]);
  });

  it("rejects an untrusted stored list", () => {
    expect(parseSkipList(undefined)).toEqual([]);
    expect(parseSkipList("not-an-array")).toEqual([]);
    expect(parseSkipList([1, "", "a", "a", "b", { jobId: "c" }])).toEqual(["a", "b"]);
    expect(parseSkipList(Array.from({ length: swipeSkipLimit + 10 }, (_, index) => `job-${index}`))).toHaveLength(swipeSkipLimit);
  });
});

describe("seen memory", () => {
  it("remembers a presented role once, most recent first, and bounds the list", () => {
    expect(rememberSeen(["b", "a"], "a")).toEqual(["a", "b"]);
    expect(rememberSeen(["a"], "b", 1)).toEqual(["b"]);
    expect(forgetSeen(["a", "b"], "a")).toEqual(["b"]);
  });

  it("rejects an untrusted stored seen list", () => {
    expect(parseSeenList(undefined)).toEqual([]);
    expect(parseSeenList(["x", "x", 3, "", "y"])).toEqual(["x", "y"]);
  });

  it("uses a seen key distinct from the skip key", () => {
    expect(swipeSeenCacheKey).not.toBe(swipeSkipCacheKey);
  });
});

describe("shouldLoadMoreDeck", () => {
  it("prefetches while a cursor remains and the buffer is shallow", () => {
    expect(shouldLoadMoreDeck({ remaining: 3, cursor: "5", loading: false, errored: false, minimum: 5 })).toBe(true);
    expect(shouldLoadMoreDeck({ remaining: 9, cursor: "5", loading: false, errored: false, minimum: 5 })).toBe(false);
  });

  it("never fetches without a cursor, mid-flight, or after an error", () => {
    expect(shouldLoadMoreDeck({ remaining: 0, loading: false, errored: false })).toBe(false);
    expect(shouldLoadMoreDeck({ remaining: 0, cursor: "5", loading: true, errored: false })).toBe(false);
    expect(shouldLoadMoreDeck({ remaining: 0, cursor: "5", loading: false, errored: true })).toBe(false);
  });

  it("keeps two full pages of ready cards ahead by default", () => {
    expect(swipeDeckPrefetchFloor).toBe(50);
    expect(shouldLoadMoreDeck({ remaining: swipeDeckPrefetchFloor, cursor: "5", loading: false, errored: false })).toBe(true);
    expect(shouldLoadMoreDeck({ remaining: swipeDeckPrefetchFloor + 1, cursor: "5", loading: false, errored: false })).toBe(false);
  });
});

describe("parseDeckCache", () => {
  it("keeps role-shaped rows and a short cursor", () => {
    expect(parseDeckCache({ jobs: [{ jobId: "a" }, { jobId: "" }, null, 5, { jobId: "b" }], cursor: "25" }))
      .toEqual({ jobs: [{ jobId: "a" }, { jobId: "b" }], cursor: "25" });
  });

  it("rejects a cache that holds no roles", () => {
    expect(parseDeckCache(undefined)).toBeUndefined();
    expect(parseDeckCache([{ jobId: "a" }])).toBeUndefined();
    expect(parseDeckCache({ jobs: "nope" })).toBeUndefined();
    expect(parseDeckCache({ jobs: [] })).toBeUndefined();
  });

  it("drops an oversized cursor", () => {
    expect(parseDeckCache({ jobs: [{ jobId: "a" }], cursor: "x".repeat(200) })).toEqual({ jobs: [{ jobId: "a" }] });
  });
});
