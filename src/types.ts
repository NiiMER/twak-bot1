// Inter-layer contracts. These are the seams between Data → Brain → Kernel →
// Exec → Ledger. Getting them right now means each layer can be built and tested
// in isolation while the tracer bullet proves they compose.

export type Direction = "buy" | "sell" | "hold";
export type Regime = "trending" | "chopping" | "risk_off";

/** Output of the DATA/EDGE layer: a normalized, timestamped snapshot. */
export interface SignalBundle {
  timestamp: string;
  asset: string; // symbol, e.g. "CAKE"
  // Raw per-source payloads (CMC families + chain-native). Normalized fields are
  // added in Phase 2; the tracer bullet only needs `asset` + a price to flow.
  cmc: {
    priceUsd?: number;
    volume24hUsd?: number; // 24h traded USD volume — depth-of-interest, drives radar promotion
    fearGreed?: number;
    fundingRate?: number;
    rsi?: number;
    macd?: number;
    marketRsi?: number; // market-cap-wide RSI14 (breadth) — CMC marketcap technical analysis
    news?: string[]; // recent headlines for the asset — CMC news (event risk)
    narratives?: string[]; // top trending narratives (social/narrative heat) — CMC
    macroEvents?: string[]; // imminent market-moving macro events — CMC
  };
  chain: {
    liquidityUsd?: number; // on-chain DEX liquidity (PancakeSwap pair, via RPC) — safety gate
    swapCount?: number; // DEX swaps in the lookback window (NOT 24h) — "is anyone trading it"
    dexImbalance?: number; // (future) buy/sell flow from Swap events
    walletFlow?: number; // (future)
    isHoneypot?: boolean;
  };
  paidViaX402?: boolean; // true if any source was fetched via a paid x402 call
}

/** Output of the BRAIN layer. The LLM proposes; it NEVER sizes and NEVER signs. */
export interface Proposal {
  regime: Regime;
  asset: string;
  direction: Direction;
  conviction: number; // 0..1
  thesis: string; // falsifiable: what must be true for this to work
}

/** Snapshot of where we stand — fed to the kernel for sizing + drawdown checks. */
export interface PortfolioState {
  equityUsd: number;
  peakEquityUsd: number;
  positions: Record<string, number>; // symbol -> USD notional
  tradesToday: number;
  tradeVolumeTodayUsd: number; // for the kernel's daily-volume cap
}

/** What the kernel emits a sized, bounded order or a logged rejection. */
export type KernelDecision =
  | { ok: true; order: SizedOrder }
  | { ok: false; reason: string };

export interface SizedOrder {
  asset: string;
  direction: Direction;
  sizeUsd: number;
  maxSlippageBps: number;
}

/** Result of execution via TWAK (the sole self-custodial path). */
export interface ExecResult {
  txHash: string;
  filledAsset: string;
  filledUsd: number;
}

/** One append-only ledger row — the spine of the learning loop + the demo + the
 *  judges' strategy explanation. Built once, used four ways. */
export interface LedgerEntry {
  ts: string;
  bundle: SignalBundle;
  proposal: Proposal;
  decision: KernelDecision;
  exec?: ExecResult;
  outcome?: { pnlUsd: number; thesisHeld: boolean };
  selfGrade?: number; // -1..1
  weightDelta?: Record<string, number>;
}

/** The committed risk rules (mirrors constitution.json). */
export interface Constitution {
  version: number;
  risk: { hardDrawdownPct: number; dqDrawdownPct: number };
  sizing: {
    perTradeMaxPctOfEquity: number;
    dailyMaxTradeVolumePctOfEquity: number;
    maxSlippageBps: number;
  };
  allocation: { survivalCorePct: number; activeSleevePct: number };
  trading: { minTradesPerDay: number; spotOnly: boolean };
  allowlist: { symbols: string[] };
}
