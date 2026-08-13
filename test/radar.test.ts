import { describe, expect, it } from "vitest";
import {
  assessPromotion,
  mean,
  median,
  pruneRadar,
  recordObservation,
  type RadarObservation,
} from "../src/radar/index.js";
import type { PromotionCriteria } from "../src/universe/index.js";

const C: PromotionCriteria = {
  minObservations: 3,
  minLiquidityUsd: 100_000,
  minVolume24hUsd: 1_000_000,
  minSwapCount: 10,
  minAvgConviction: 0.4,
};

/** An observation that clears every bar; override one field to test one failure. */
const obs = (o: Partial<RadarObservation> = {}): RadarObservation => ({
  ts: "2026-08-13T00:00:00Z",
  priceUsd: 10,
  liquidityUsd: 500_000,
  volume24hUsd: 5_000_000,
  swapCount: 50,
  regime: "trending",
  direction: "buy",
  conviction: 0.7,
  thesis: "t",
  news: [],
  ...o,
});

describe("median / mean", () => {
  it("takes the middle value, and averages the two middles when even", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("ignores undefined and non-finite readings", () => {
    expect(median([1, undefined, 3])).toBe(2);
    expect(mean([2, undefined, 4])).toBe(3);
    expect(median([Number.NaN, 5])).toBe(5);
  });

  it("returns undefined when nothing was measured", () => {
    expect(median([])).toBeUndefined();
    expect(median([undefined, undefined])).toBeUndefined();
    expect(mean([])).toBeUndefined();
  });
});

describe("assessPromotion", () => {
  it("marks an asset ready only when every check passes", () => {
    const a = assessPromotion("PENDLE", [obs(), obs(), obs()], C);
    expect(a.ready).toBe(true);
    expect(a.score).toBe(1);
    expect(a.checks.every((k) => k.ok)).toBe(true);
  });

  it("is not ready before the observation floor, however good the numbers", () => {
    const a = assessPromotion("PENDLE", [obs(), obs()], C);
    expect(a.ready).toBe(false);
    expect(a.checks.find((k) => k.name === "observations")?.ok).toBe(false);
  });

  it("judges on the median, so one spike can't earn a promotion", () => {
    // Two dead readings and one huge one: median stays below the floor.
    const a = assessPromotion(
      "X",
      [obs({ liquidityUsd: 1_000 }), obs({ liquidityUsd: 1_000 }), obs({ liquidityUsd: 90_000_000 })],
      C,
    );
    expect(a.checks.find((k) => k.name === "liquidity")?.ok).toBe(false);
    expect(a.ready).toBe(false);
  });

  it("fails a check whose measurement is missing — absence of evidence isn't evidence", () => {
    const blind = [obs({ liquidityUsd: undefined }), obs({ liquidityUsd: undefined }), obs({ liquidityUsd: undefined })];
    const a = assessPromotion("X", blind, C);
    expect(a.checks.find((k) => k.name === "liquidity")?.ok).toBe(false);
    expect(a.ready).toBe(false);
  });

  it("blocks outright on a single honeypot verdict, whatever else looks good", () => {
    const a = assessPromotion("RUG", [obs(), obs(), obs({ isHoneypot: true })], C);
    expect(a.ready).toBe(false);
    expect(a.blocked).toBe("honeypot");
    expect(a.score).toBe(0);
  });

  it("scores partial progress so near-misses can be ranked", () => {
    // Volume alone fails → 4 of 5 checks pass.
    const a = assessPromotion("X", [obs({ volume24hUsd: 1 }), obs({ volume24hUsd: 1 }), obs({ volume24hUsd: 1 })], C);
    expect(a.ready).toBe(false);
    expect(a.score).toBeCloseTo(0.8);
  });

  it("uses mean conviction — a sustained read, not one good pass", () => {
    const a = assessPromotion(
      "X",
      [obs({ conviction: 0.9 }), obs({ conviction: 0.1 }), obs({ conviction: 0.1 })],
      C,
    );
    expect(a.checks.find((k) => k.name === "conviction")?.ok).toBe(false); // mean 0.367 < 0.4
  });

  it("reports zero observations without throwing", () => {
    const a = assessPromotion("NEW", [], C);
    expect(a.ready).toBe(false);
    expect(a.observations).toBe(0);
  });
});

describe("recordObservation / pruneRadar", () => {
  it("appends per asset without touching the others", () => {
    const s1 = recordObservation({}, "A", obs({ priceUsd: 1 }));
    const s2 = recordObservation(s1, "B", obs({ priceUsd: 2 }));
    const s3 = recordObservation(s2, "A", obs({ priceUsd: 3 }));
    expect(s3.A?.map((o) => o.priceUsd)).toEqual([1, 3]);
    expect(s3.B?.map((o) => o.priceUsd)).toEqual([2]);
  });

  it("caps history so a long-running agent can't grow the file forever", () => {
    let store = {};
    for (let i = 0; i < 520; i++) store = recordObservation(store, "A", obs({ priceUsd: i }));
    const kept = (store as Record<string, RadarObservation[]>).A!;
    expect(kept.length).toBe(500);
    expect(kept[kept.length - 1]!.priceUsd).toBe(519); // newest retained
    expect(kept[0]!.priceUsd).toBe(20); // oldest dropped
  });

  it("drops history for assets no longer on radar", () => {
    const store = recordObservation(recordObservation({}, "A", obs()), "GONE", obs());
    expect(pruneRadar(store, [{ symbol: "A" }])).toEqual({ A: store.A });
  });
});
