import { describe, expect, it } from "vitest";
import { evaluate } from "../src/kernel/index.js";
import type { Constitution, PortfolioState, Proposal } from "../src/types.js";

// The kernel is the most-tested unit: it's the floor that prevents a DQ and the
// guardrail the TWAK special scores. Every limit gets a table-driven test.

const C: Constitution = {
  version: 1,
  risk: { hardDrawdownPct: 20, dqDrawdownPct: 30 },
  sizing: { perTradeMaxPctOfEquity: 15, dailyMaxTradeVolumePctOfEquity: 40, maxSlippageBps: 100 },
  allocation: { survivalCorePct: 35, activeSleevePct: 65 },
  trading: { minTradesPerDay: 1, spotOnly: true },
  allowlist: { symbols: ["CAKE", "ETH"] },
};

const healthy: PortfolioState = { equityUsd: 1000, peakEquityUsd: 1000, positions: {}, tradesToday: 0, tradeVolumeTodayUsd: 0 };
const buy = (asset: string, conviction = 1): Proposal => ({
  regime: "trending", asset, direction: "buy", conviction, thesis: "t",
});

describe("risk kernel", () => {
  it("approves an allowlisted buy and sizes within the per-trade cap", () => {
    const d = evaluate(buy("CAKE"), healthy, C);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.order.sizeUsd).toBeLessThanOrEqual(1000 * 0.15);
  });

  it("rejects assets outside the allowlist", () => {
    const d = evaluate(buy("DOGE"), healthy, C);
    expect(d.ok).toBe(false);
  });

  describe("radar tier (observation only)", () => {
    it("refuses to open exposure on a radar asset, even a perfect allowlisted buy", () => {
      const d = evaluate(buy("CAKE"), healthy, C, { radarOnly: true });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toMatch(/radar-only/);
    });

    it("still allows EXITING a radar asset — demoting one you hold must not trap it", () => {
      const held: PortfolioState = { ...healthy, positions: { CAKE: 200 } };
      const sell: Proposal = { regime: "chopping", asset: "CAKE", direction: "sell", conviction: 0.5, thesis: "t" };
      const d = evaluate(sell, held, C, { radarOnly: true });
      expect(d.ok).toBe(true);
      if (d.ok) expect(d.order).toMatchObject({ direction: "sell", sizeUsd: 200 });
    });

    it("still flattens a held radar asset in risk-off", () => {
      const held: PortfolioState = { ...healthy, positions: { CAKE: 150 } };
      const d = evaluate(buy("CAKE"), held, C, { radarOnly: true, regime: "risk_off" });
      expect(d.ok).toBe(true);
      if (d.ok) expect(d.order).toMatchObject({ direction: "sell", sizeUsd: 150 });
    });

    it("leaves normal assets untouched when the flag is absent or false", () => {
      expect(evaluate(buy("CAKE"), healthy, C, { radarOnly: false }).ok).toBe(true);
      expect(evaluate(buy("CAKE"), healthy, C, {}).ok).toBe(true);
    });
  });

  it("trips the drawdown kill-switch at the hard floor", () => {
    const drawn: PortfolioState = { ...healthy, equityUsd: 790, peakEquityUsd: 1000 }; // 21% dd
    const d = evaluate(buy("CAKE"), drawn, C);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/drawdown/);
  });

  it("scales size down with conviction", () => {
    const hi = evaluate(buy("CAKE", 1.0), healthy, C);
    const lo = evaluate(buy("CAKE", 0.2), healthy, C);
    if (hi.ok && lo.ok) expect(lo.order.sizeUsd).toBeLessThan(hi.order.sizeUsd);
  });

  it("treats hold as a no-op", () => {
    const d = evaluate({ ...buy("CAKE"), direction: "hold" }, healthy, C);
    expect(d.ok).toBe(false);
  });

  it("fails closed on NaN / non-positive equity (does not let NaN defeat the kill-switch)", () => {
    const nan: PortfolioState = { ...healthy, equityUsd: Number.NaN };
    expect(evaluate(buy("CAKE"), nan, C).ok).toBe(false);
    const zero: PortfolioState = { ...healthy, equityUsd: 0 };
    expect(evaluate(buy("CAKE"), zero, C).ok).toBe(false);
  });

  it("rejects once the daily volume cap is reached", () => {
    // dailyMax 40% of $1000 = $400 already traded today
    const maxedOut: PortfolioState = { ...healthy, tradeVolumeTodayUsd: 400 };
    const d = evaluate(buy("CAKE"), maxedOut, C);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/daily volume cap/);
  });

  it("clamps size to the remaining daily budget", () => {
    // $360 used of the $400 daily cap → only $40 left, below the $150 per-trade cap
    const nearCap: PortfolioState = { ...healthy, tradeVolumeTodayUsd: 360 };
    const d = evaluate(buy("CAKE", 1.0), nearCap, C);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.order.sizeUsd).toBeCloseTo(40);
  });

  describe("pre-buy safety gates", () => {
    it("refuses to buy a flagged honeypot", () => {
      const d = evaluate(buy("CAKE"), healthy, C, { isHoneypot: true });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toMatch(/honeypot/);
    });

    it("refuses to buy below the DEX liquidity floor", () => {
      const d = evaluate(buy("CAKE"), healthy, C, { liquidityUsd: 10_000 });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toMatch(/liquidity/);
    });

    it("approves a buy with healthy liquidity and no honeypot flag", () => {
      const d = evaluate(buy("CAKE"), healthy, C, { isHoneypot: false, liquidityUsd: 1_000_000 });
      expect(d.ok).toBe(true);
    });

    it("does not block buys when safety is unverified (fail-open)", () => {
      expect(evaluate(buy("CAKE"), healthy, C, {}).ok).toBe(true);
    });

    it("refuses a BUY in a risk-off regime (active sleeve flat — even if the LLM proposes it)", () => {
      const d = evaluate(buy("CAKE"), healthy, C, { regime: "risk_off" });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toMatch(/risk-off/);
    });

    it("allows a BUY in trending / chopping regimes", () => {
      expect(evaluate(buy("CAKE"), healthy, C, { regime: "trending" }).ok).toBe(true);
      expect(evaluate(buy("CAKE"), healthy, C, { regime: "chopping" }).ok).toBe(true);
    });

    it("lets a SELL through even when the token is a honeypot (you can always exit)", () => {
      const held: PortfolioState = { ...healthy, positions: { CAKE: 200 } };
      const sell: Proposal = { ...buy("CAKE"), direction: "sell" };
      const d = evaluate(sell, held, C, { isHoneypot: true, liquidityUsd: 1 });
      expect(d.ok).toBe(true);
      if (d.ok) expect(d.order.sizeUsd).toBeCloseTo(200); // sized to the full held position
    });
  });

  describe("exit path (sells de-risk and are always allowed)", () => {
    const held = (usd: number): PortfolioState => ({ ...healthy, positions: { CAKE: usd } });
    const sell = (asset = "CAKE"): Proposal => ({ ...buy(asset), direction: "sell" });

    it("approves a sell sized to the full held position", () => {
      const d = evaluate(sell(), held(250), C);
      expect(d.ok).toBe(true);
      if (d.ok) expect(d.order.sizeUsd).toBeCloseTo(250);
    });

    it("rejects a sell when nothing is held", () => {
      const d = evaluate(sell(), healthy, C);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toMatch(/no CAKE position/);
    });

    it("allows a protective exit PAST the drawdown kill-switch", () => {
      const drawn: PortfolioState = { ...held(250), equityUsd: 790, peakEquityUsd: 1000 }; // 21% dd
      expect(evaluate(sell(), drawn, C).ok).toBe(true); // buys blocked here, exits must not be
    });

    it("allows an exit in a risk-off regime and ignores the daily cap", () => {
      const maxed: PortfolioState = { ...held(250), tradeVolumeTodayUsd: 400 };
      expect(evaluate(sell(), maxed, C, { regime: "risk_off" }).ok).toBe(true);
    });
  });

  describe("deterministic risk-off flatten (kernel-enforced survival, not LLM-dependent)", () => {
    const held = (usd: number): PortfolioState => ({ ...healthy, positions: { CAKE: usd } });

    it("force-sells a held position in risk-off even when the brain says HOLD", () => {
      const d = evaluate({ ...buy("CAKE"), direction: "hold" }, held(300), C, { regime: "risk_off" });
      expect(d.ok).toBe(true);
      if (d.ok) {
        expect(d.order.direction).toBe("sell");
        expect(d.order.sizeUsd).toBeCloseTo(300);
      }
    });

    it("force-sells in risk-off even when the brain proposes a BUY", () => {
      const d = evaluate(buy("CAKE"), held(300), C, { regime: "risk_off" });
      expect(d.ok).toBe(true);
      if (d.ok) expect(d.order.direction).toBe("sell");
    });

    it("flattens past the drawdown kill-switch (de-risking is never blocked)", () => {
      const drawn: PortfolioState = { ...held(300), equityUsd: 700, peakEquityUsd: 1000 }; // 30% dd
      const d = evaluate({ ...buy("CAKE"), direction: "hold" }, drawn, C, { regime: "risk_off" });
      expect(d.ok).toBe(true);
      if (d.ok) expect(d.order.direction).toBe("sell");
    });

    it("when already flat in risk-off, blocks a new long (no position to flatten)", () => {
      const d = evaluate(buy("CAKE"), healthy, C, { regime: "risk_off" });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toMatch(/risk-off/);
    });
  });
});
