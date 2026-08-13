import type { Snapshot } from "@/lib/types";

// Snapshot fixtures shared by the unit tests and the Playwright e2e suite, so
// both drive the console through the SAME states and a scenario can't silently
// diverge between the two layers.

/** Deep-partial for the Snapshot shape.
 *  NonNullable matters: an optional field like `pnl?` is `{...} | undefined`,
 *  which does NOT extend `object`, so a naive version would demand every
 *  sub-field back. Arrays are replaced wholesale, never merged index-by-index. */
type Deep<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends readonly unknown[]
    ? T[K]
    : NonNullable<T[K]> extends object
      ? Deep<NonNullable<T[K]>>
      : T[K];
};

// Recursion stays untyped; Deep<T> is enforced at the makeSnapshot boundary.
// An explicitly-undefined key (e.g. `pnl: undefined`) is preserved by
// Object.entries, so a scenario can REMOVE an optional block, not just override it.
function mergeRaw(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
        ? mergeRaw(cur as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

/** The baseline: a healthy agent with an APPROVED buy and every signal present. */
export function makeSnapshot(over: Deep<Snapshot> = {}): Snapshot {
  const base: Snapshot = {
    agent: {
      name: "PLIMSOLL",
      mode: "live",
      wallet: "0xB848C0315997B683F702fd877Ce220293CFda1e5",
      agentId: "129312",
      registry: "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
      constitutionHash: "0x7c0af11bda62efaea35892ee53bc6ee926fff1a15b404564183a253b582c152e",
      registered: true,
    },
    asOf: "2026-06-07T17:30:00.000Z",
    cycle: 412,
    latestDecision: {
      asset: "CAKE",
      regime: "trending",
      direction: "buy",
      conviction: 0.72,
      thesis: "Momentum confirmed with positive funding; invalidated if RSI closes below 45.",
      sizeUsd: 108,
      approved: true,
      kernelReason: "approved — within per-trade cap",
    },
    signals: {
      cmc: {
        priceUsd: 1.2626,
        fearGreed: 62,
        fundingRate: 0.0031,
        rsi: 58.4,
        macd: 0.0421,
        marketRsi: 54.2,
        news: ["Altcoin rotation broadens as funding flips positive"],
        narratives: ["Binance Ecosystem", "Layer 1", "AI Agents"],
        macroEvents: ["June FOMC Press Conference (17 June 2026)"],
      },
      chain: { liquidityUsd: 13_453_690, dexImbalance: 0.42, walletFlow: 5_120, isHoneypot: false },
    },
    portfolio: {
      equityUsd: 1_042.18,
      peakEquityUsd: 1_061.45,
      drawdownPct: 1.8,
      equityCurve: [
        { t: "wk1", equity: 1000 },
        { t: "wk2", equity: 1024 },
        { t: "wk3", equity: 1011 },
        { t: "wk4", equity: 1042 },
      ],
    },
    pnl: {
      startEquityUsd: 1000,
      currentEquityUsd: 1042.18,
      pnlUsd: 42.18,
      pnlPct: 4.22,
      windowStarted: true,
      windowStartIso: "2026-06-22T00:00:00Z",
    },
    learning: { trending: 1.14, chopping: 0.92, risk_off: 1.0 },
    guardrails: {
      allowlist: 148,
      perTradePct: 15,
      dailyPct: 40,
      slippageBps: 100,
      liquidityFloorUsd: 50_000,
      killSwitchPct: 20,
      dqPct: 30,
      honeypotGate: true,
    },
    ledger: [
      {
        ts: "17:30:02",
        asset: "CAKE",
        regime: "trending",
        direction: "buy",
        conviction: 0.72,
        approved: true,
        note: "momentum confirmed, sized to conviction",
      },
      {
        ts: "17:25:01",
        asset: "INJ",
        regime: "chopping",
        direction: "buy",
        conviction: 0.4,
        approved: false,
        note: "kernel veto — DEX liquidity below floor",
      },
      {
        ts: "17:20:00",
        asset: "ETH",
        regime: "chopping",
        direction: "hold",
        conviction: 0.2,
        approved: false,
        note: "no edge, standing down",
      },
    ],
    backtest: {
      asset: "CAKE",
      candles: 365,
      buyHoldPct: -62.4,
      strategyPct: 8.1,
      grossPct: 9.5,
      maxDdPct: 11.2,
      trades: 6,
      winRatePct: 67,
    },
    proof: {
      swapTx: "0xf24bc1ca67f50d6eec42c370125d8bcde064b9d96d2121e92038ef8b77539fd1",
      registerTx: "0xreg1111111111111111111111111111111111111111111111111111111111111",
      setMetadataTx: "0xmeta222222222222222222222222222222222222222222222222222222222222",
      competeTx: "0xcomp33333333333333333333333333333333333333333333333333333333333",
    },
  };
  return mergeRaw(base as unknown as Record<string, unknown>, over as Record<string, unknown>) as unknown as Snapshot;
}

/** The scenarios both suites drive the console through. */
export const scenarios = {
  /** Healthy, approved buy — the happy path. */
  approved: () => makeSnapshot(),

  /** Kernel veto: risk-off, sleeve flat, nothing executed. */
  veto: () =>
    makeSnapshot({
      latestDecision: {
        regime: "risk_off",
        direction: "hold",
        conviction: 0,
        sizeUsd: 0,
        approved: false,
        kernelReason: "risk-off — sleeve flat",
        thesis: "Extreme fear with negative funding; the active sleeve stays flat.",
      },
      signals: { cmc: { fearGreed: 14, fundingRate: -0.0027, marketRsi: 14.2 }, chain: { dexImbalance: -0.99 } },
    }),

  /** Every optional signal missing — the fail-soft path. Must render em-dashes. */
  blindSignals: () =>
    makeSnapshot({
      signals: {
        cmc: {
          priceUsd: undefined,
          fearGreed: undefined,
          fundingRate: undefined,
          rsi: undefined,
          macd: undefined,
          marketRsi: undefined,
          news: [],
          narratives: [],
          macroEvents: [],
        },
        chain: {
          liquidityUsd: undefined,
          dexImbalance: undefined,
          walletFlow: undefined,
          isHoneypot: undefined,
        },
      },
    }),

  /** Drawdown past the kill-switch, and a honeypot flagged. */
  distressed: () =>
    makeSnapshot({
      portfolio: { equityUsd: 780, peakEquityUsd: 1_061.45, drawdownPct: 26.5 },
      pnl: { pnlUsd: -220, pnlPct: -22.0, currentEquityUsd: 780 },
      signals: { chain: { isHoneypot: true, liquidityUsd: 12_000 } },
      latestDecision: { approved: false, kernelReason: "drawdown 26.5% >= kill-switch 20%" },
    }),

  /** A dev-mode agent that has not registered on-chain. */
  devUnregistered: () => makeSnapshot({ agent: { mode: "dev", registered: false } }),

  /** No PnL block — older/live snapshots may omit it; the panel must not render. */
  noPnl: () => makeSnapshot({ pnl: undefined }),
} as const;

export type ScenarioName = keyof typeof scenarios;
