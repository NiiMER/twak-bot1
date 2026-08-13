import { drawdownPct } from "../portfolio/index.js";
import type {
  Constitution,
  KernelDecision,
  PortfolioState,
  Proposal,
  Regime,
} from "../types.js";

// Minimum DEX liquidity to enter a token — skip thin pools (slippage / rug risk).
// Shared with the brain's rule proposer so both layers use one floor.
export const MIN_LIQUIDITY_USD = 50_000;

/** Runtime context for the kernel: live chain facts that aren't policy constants,
 *  plus the asset's universe tier (from universe.yaml). */
export interface SafetySignals {
  isHoneypot?: boolean; // honeypot.is verdict (undefined = unverified → don't block)
  liquidityUsd?: number; // on-chain DEX liquidity (undefined = unverified → don't block)
  regime?: Regime; // the DETERMINISTIC regime (detectRegime), not the LLM's self-label
  radarOnly?: boolean; // observation tier — may never OPEN exposure (exits still allowed)
}

// SAFETY LAYER — the deterministic risk kernel. PURE function (no I/O) so it's
// exhaustively unit-testable and impossible to "talk past" with a prompt. Every
// order must pass here BEFORE it reaches the signer. This is the guardrail the
// TWAK special rewards and the floor that keeps us out of DQ.
//
// NOTE: enforcement is in OUR code, not at the signing key — TWAK has no signing
// policy (confirmed). We do NOT claim "physically unsignable"; we claim "no
// out-of-policy order is ever constructed or sent."
export function evaluate(
  proposal: Proposal,
  portfolio: PortfolioState,
  c: Constitution,
  safety: SafetySignals = {},
): KernelDecision {
  // 0. Fail closed on a corrupt portfolio (NaN/<=0 equity from a bad chain read).
  //    Otherwise NaN slips past every `>=` comparison and DEFEATS the kill-switch.
  if (!Number.isFinite(portfolio.equityUsd) || portfolio.equityUsd <= 0 || !Number.isFinite(portfolio.peakEquityUsd)) {
    return { ok: false, reason: "portfolio equity not finite/positive — refusing to trade" };
  }

  // 0b. DETERMINISTIC RISK-OFF FLATTEN — the survival guarantee, ENFORCED BY THE
  //     KERNEL so it cannot be talked past by the brain. If the detector says
  //     risk-off and we still hold this asset, exit it regardless of what the brain
  //     proposed (hold / buy / even a stale sell all collapse to "go flat"). Without
  //     this, "flat in risk-off" would depend on the LLM choosing to sell — here it
  //     is a deterministic property of the kernel. De-risking is always allowed, so
  //     this bypasses the kill-switch and the daily cap like any other exit.
  if (safety.regime === "risk_off") {
    const heldUsd = portfolio.positions[proposal.asset] ?? 0;
    if (heldUsd > 0) {
      return {
        ok: true,
        order: { asset: proposal.asset, direction: "sell", sizeUsd: heldUsd, maxSlippageBps: c.sizing.maxSlippageBps },
      };
    }
    // Flat already — fall through (a buy here is blocked by the risk-off gate below;
    // a hold/sell with nothing to exit is rejected as usual).
  }

  // 1. Hold = no-op, trivially fine.
  if (proposal.direction === "hold") return { ok: false, reason: "proposal is hold" };

  // 1b. EXIT PATH — a sell is de-risking and is ALWAYS allowed: it bypasses the
  //     buy-only entry gates, the drawdown kill-switch, and the daily-volume cap
  //     (you must be able to flatten in a crash or past the kill-switch). Sized to
  //     the FULL held position — an exit closes the position, it doesn't open one.
  if (proposal.direction === "sell") {
    const heldUsd = portfolio.positions[proposal.asset] ?? 0;
    if (!(heldUsd > 0)) {
      return { ok: false, reason: `no ${proposal.asset} position to exit` };
    }
    return {
      ok: true,
      order: {
        asset: proposal.asset,
        direction: "sell",
        sizeUsd: heldUsd,
        maxSlippageBps: c.sizing.maxSlippageBps,
      },
    };
  }

  // 1c. RADAR TIER — observation only, enforced here rather than by the caller
  //     remembering to skip it. Deliberately placed AFTER the exit path above: if
  //     an asset is demoted from watchlist to radar while a position is still
  //     open, we must always be able to sell out of it. What radar forbids is
  //     OPENING exposure, which is the only thing left to reach this line.
  if (safety.radarOnly === true) {
    return { ok: false, reason: `asset ${proposal.asset} is radar-only (observation tier) — no new exposure` };
  }

  // 2. Allowlist — trades outside the 148 eligible tokens do not count.
  if (!c.allowlist.symbols.includes(proposal.asset)) {
    return { ok: false, reason: `asset ${proposal.asset} not in allowlist` };
  }

  // 2b. Pre-buy safety gates (BUYS only — you can always exit a position you hold).
  //     Deterministic backstop to the brain's own checks: even if the proposer is
  //     talked into a bad entry, no honeypot/thin-pool buy is ever constructed.
  if (proposal.direction === "buy") {
    // Survival rule, hard-enforced: the active sleeve goes FLAT in risk-off. The
    // rule proposer obeys this; the LLM is only *guided* by the regime hint, so
    // the kernel enforces it deterministically (on the detector's regime, not the
    // model's self-label) — no new longs into a risk-off tape, ever.
    if (safety.regime === "risk_off") {
      return { ok: false, reason: "risk-off — active sleeve flat (no new longs)" };
    }
    if (safety.isHoneypot === true) {
      return { ok: false, reason: "honeypot flagged — refusing buy" };
    }
    if (safety.liquidityUsd !== undefined && safety.liquidityUsd < MIN_LIQUIDITY_USD) {
      return {
        ok: false,
        reason: `DEX liquidity $${Math.round(safety.liquidityUsd).toLocaleString()} < floor $${MIN_LIQUIDITY_USD.toLocaleString()}`,
      };
    }
  }

  // 3. Drawdown kill-switch — the hard floor. Trips well below the DQ line.
  const dd = drawdownPct(portfolio);
  if (dd >= c.risk.hardDrawdownPct) {
    return { ok: false, reason: `drawdown ${dd.toFixed(1)}% >= kill-switch ${c.risk.hardDrawdownPct}%` };
  }

  // 4. Daily volume cap — limits churn (simulated tx costs penalize it) and
  //    bounds how much the agent can move in a single day.
  const dailyCapUsd = portfolio.equityUsd * (c.sizing.dailyMaxTradeVolumePctOfEquity / 100);
  const dailyRemainingUsd = dailyCapUsd - portfolio.tradeVolumeTodayUsd;
  if (dailyRemainingUsd <= 0) {
    return { ok: false, reason: `daily volume cap reached (${c.sizing.dailyMaxTradeVolumePctOfEquity}% of equity)` };
  }

  // 5. Size by conviction, capped by BOTH the per-trade limit and the daily
  //    remaining budget. (Phase 4: vol-targeting replaces flat per-trade cap.)
  const perTradeCapUsd = portfolio.equityUsd * (c.sizing.perTradeMaxPctOfEquity / 100);
  const sizeUsd = Math.min(perTradeCapUsd * clamp01(proposal.conviction), perTradeCapUsd, dailyRemainingUsd);
  if (sizeUsd <= 0) return { ok: false, reason: "computed size <= 0" };

  return {
    ok: true,
    order: {
      asset: proposal.asset,
      direction: proposal.direction,
      sizeUsd,
      maxSlippageBps: c.sizing.maxSlippageBps,
    },
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
