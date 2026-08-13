import { describe, expect, it } from "vitest";
import { DEFAULT_PROMOTION, buildUniverse } from "../src/universe/index.js";

// The universe decides which assets may spend money, so its failure modes matter
// as much as its happy path: a config that's ambiguous about the traded tier must
// stop the agent, not get guessed at.

const ALLOW = ["ETH", "CAKE", "DOGE"];

describe("buildUniverse", () => {
  it("accepts bare symbols and {symbol, note} objects in the same tier", () => {
    const u = buildUniverse(
      { version: 1, watchlist: ["ETH", { symbol: "CAKE", note: "deep book" }], radar: [] },
      ALLOW,
    );
    expect(u.watchlist).toEqual([{ symbol: "ETH" }, { symbol: "CAKE", note: "deep book" }]);
  });

  it("drops watchlist symbols outside the eligible allowlist and records them", () => {
    const u = buildUniverse({ version: 1, watchlist: ["ETH", "BNB"], radar: [] }, ALLOW);
    expect(u.watchlist.map((a) => a.symbol)).toEqual(["ETH"]);
    expect(u.dropped).toEqual(["BNB"]);
  });

  it("does NOT allowlist-filter radar — watching an ineligible asset is the point", () => {
    const u = buildUniverse({ version: 1, watchlist: ["ETH"], radar: ["BNB", "PENDLE"] }, ALLOW);
    expect(u.radar.map((a) => a.symbol)).toEqual(["BNB", "PENDLE"]);
  });

  it("refuses a symbol listed in BOTH tiers — trade intent would be ambiguous", () => {
    expect(() => buildUniverse({ version: 1, watchlist: ["ETH"], radar: ["ETH"] }, ALLOW)).toThrow(/BOTH/);
  });

  it("catches the both-tiers conflict regardless of case", () => {
    expect(() => buildUniverse({ version: 1, watchlist: ["ETH"], radar: ["eth"] }, ALLOW)).toThrow(/BOTH/);
  });

  it("refuses duplicates within a tier", () => {
    expect(() => buildUniverse({ version: 1, watchlist: ["ETH", "ETH"], radar: [] }, ALLOW)).toThrow(/twice/);
    expect(() => buildUniverse({ version: 1, watchlist: [], radar: ["X", "x"] }, ALLOW)).toThrow(/twice/);
  });

  it("rejects a malformed file rather than starting with a partial universe", () => {
    expect(() => buildUniverse({ watchlist: ["ETH"] }, ALLOW)).toThrow(); // no version
    expect(() => buildUniverse({ version: 1, watchlist: [""] }, ALLOW)).toThrow(); // empty symbol
    expect(() => buildUniverse("not an object", ALLOW)).toThrow();
  });

  it("defaults both tiers to empty and fills in default promotion criteria", () => {
    const u = buildUniverse({ version: 1 }, ALLOW);
    expect(u.watchlist).toEqual([]);
    expect(u.radar).toEqual([]);
    expect(u.promotion).toEqual(DEFAULT_PROMOTION);
  });

  it("merges a partial radarPromotion over the defaults", () => {
    const u = buildUniverse({ version: 1, radarPromotion: { minObservations: 3 } }, ALLOW);
    expect(u.promotion.minObservations).toBe(3);
    expect(u.promotion.minLiquidityUsd).toBe(DEFAULT_PROMOTION.minLiquidityUsd);
  });

  it("rejects an out-of-range conviction floor (conviction is 0..1)", () => {
    expect(() => buildUniverse({ version: 1, radarPromotion: { minAvgConviction: 5 } }, ALLOW)).toThrow();
  });

  it("trims symbols and rejects blank ones", () => {
    const u = buildUniverse({ version: 1, watchlist: ["  ETH  "], radar: [] }, ALLOW);
    expect(u.watchlist).toEqual([{ symbol: "ETH" }]);
    // "  " passes a naive .min(1) but normalizes to an empty symbol.
    expect(() => buildUniverse({ version: 1, watchlist: ["   "] }, ALLOW)).toThrow();
    expect(() => buildUniverse({ version: 1, radar: [{ symbol: " " }] }, ALLOW)).toThrow();
  });

  it("rejects an unknown key inside an entry object", () => {
    expect(() => buildUniverse({ version: 1, radar: [{ symbol: "X", nte: "typo" }] }, ALLOW)).toThrow();
  });

  it("preserves symbol case so mixed-case allowlist entries stay tradeable", () => {
    // constitution.json holds XAUt / USDe / lisUSD — upper-casing the stored
    // symbol would silently make every one of them un-tradeable.
    const u = buildUniverse({ version: 1, watchlist: ["XAUt"], radar: [] }, ["XAUt"]);
    expect(u.watchlist).toEqual([{ symbol: "XAUt" }]);
    expect(u.dropped).toEqual([]);
  });

  it("rejects unknown keys — a typo must not silently empty a tier", () => {
    // `watchList` would otherwise be stripped, leaving nothing traded and no error.
    expect(() => buildUniverse({ version: 1, watchList: ["ETH"] }, ALLOW)).toThrow();
    expect(() => buildUniverse({ version: 1, radarPromotion: { minObs: 3 } }, ALLOW)).toThrow();
  });
});
