import { describe, expect, it } from "vitest";
import { computeFlow, computeLiquidityUsd } from "../src/signals/chain.js";

describe("computeLiquidityUsd", () => {
  it("values a pool as 2× the WBNB-side reserve in USD", () => {
    // 10 WBNB (1e19 wei) at $600 → one side $6000 → pool ≈ $12000
    expect(computeLiquidityUsd(10n * 10n ** 18n, 600)).toBeCloseTo(12000);
  });

  it("scales with reserve and price", () => {
    expect(computeLiquidityUsd(10n ** 18n, 600)).toBeCloseTo(1200); // 1 WBNB
    expect(computeLiquidityUsd(0n, 600)).toBe(0);
  });
});

describe("computeFlow (Swap-event buy/sell pressure)", () => {
  const e = (inW: number, outW: number) => ({ wbnbIn: BigInt(inW) * 10n ** 18n, wbnbOut: BigInt(outW) * 10n ** 18n });

  it("is positive when buys (WBNB-in) exceed sells", () => {
    const f = computeFlow([e(3, 0), e(1, 0), e(0, 1)], 600); // 4 WBNB buy, 1 sell
    expect(f.dexImbalance).toBeCloseTo((4 - 1) / (4 + 1)); // 0.6
    expect(f.walletFlowUsd).toBeCloseTo((4 - 1) * 600);
  });

  it("is negative when sells dominate", () => {
    const f = computeFlow([e(0, 5), e(1, 0)], 600);
    expect(f.dexImbalance!).toBeLessThan(0);
  });

  it("returns no flow figures when there's no WBNB movement", () => {
    expect(computeFlow([], 600)).toEqual({ swapCount: 0 });
    // A swap with zero WBNB on both sides still HAPPENED — count it, but report
    // no imbalance. Silence and zero-value activity are different signals.
    expect(computeFlow([e(0, 0)], 600)).toEqual({ swapCount: 1 });
  });

  it("counts every swap in the window, flow or not", () => {
    expect(computeFlow([e(3, 0), e(0, 1), e(0, 0)], 600).swapCount).toBe(3);
  });
});
