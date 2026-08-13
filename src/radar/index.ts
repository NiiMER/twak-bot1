import { existsSync, readFileSync } from "node:fs";
import { atomicWriteJson, statePath } from "../util/io.js";
import type { PromotionCriteria, UniverseAsset } from "../universe/index.js";
import type { Direction, Regime } from "../types.js";

// THE RADAR LAYER — evidence-gathering for assets we deliberately do NOT trade.
//
// A radar asset runs the same read path as a traded one (signals → brain), but
// stops before the kernel can open exposure. What we keep is the evidence a
// promotion decision actually needs: is there depth, is anyone trading it, and
// did the brain's read hold up across many passes rather than one good hour.
//
// Nothing here promotes anything. assessPromotion reports whether an asset has
// cleared the bar; moving it into the watchlist stays a human edit to
// universe.yaml, because that edit is what authorizes spending money on it.

const RADAR_PATH = statePath("radar.json");
// Per-asset ring buffer. Bounded so a long-running agent can't grow the file
// without limit; large enough that the median is meaningful over days.
const MAX_OBSERVATIONS = 500;

/** One pass over a radar asset — what we saw and what the brain made of it. */
export interface RadarObservation {
  ts: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  /** DEX swaps seen in the chain lookback window (not 24h) — see signals/chain. */
  swapCount?: number;
  isHoneypot?: boolean;
  regime: Regime;
  /** What the brain WOULD have done. Recorded, never acted on. */
  direction: Direction;
  conviction: number;
  thesis: string;
  /** Headlines the brain weighed on this pass — kept for the human review step. */
  news: string[];
}

export type RadarStore = Record<string, RadarObservation[]>;

export interface PromotionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PromotionAssessment {
  asset: string;
  /** True only when every check passes. Means "candidate for review", not "promoted". */
  ready: boolean;
  /** Fraction of checks passed, 0..1 — lets you rank near-misses. */
  score: number;
  observations: number;
  checks: PromotionCheck[];
  /** Set when the asset is disqualified outright rather than merely short of the bar. */
  blocked?: string;
}

/** Median of the defined values, or undefined if none are. Median over mean so a
 *  single liquidity spike (or one dead hour) can't carry the decision. */
export function median(values: (number | undefined)[]): number | undefined {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return undefined;
  const mid = nums.length >> 1;
  return nums.length % 2 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2;
}

/** Mean of the defined values, or undefined if none are. */
export function mean(values: (number | undefined)[]): number | undefined {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

/** Pure: judge one asset's recorded history against the promotion criteria.
 *  A missing measurement FAILS its check — absence of evidence is not evidence,
 *  and this gate exists to keep money away from assets we can't see clearly. */
export function assessPromotion(
  asset: string,
  observations: RadarObservation[],
  c: PromotionCriteria,
): PromotionAssessment {
  // Honeypot is disqualifying, not a scored check: one credible honeypot verdict
  // ends the conversation regardless of how good the other numbers look.
  if (observations.some((o) => o.isHoneypot === true)) {
    return {
      asset,
      ready: false,
      score: 0,
      observations: observations.length,
      checks: [{ name: "honeypot", ok: false, detail: "flagged as a honeypot in at least one observation" }],
      blocked: "honeypot",
    };
  }

  const medLiquidity = median(observations.map((o) => o.liquidityUsd));
  const medVolume = median(observations.map((o) => o.volume24hUsd));
  const medSwaps = median(observations.map((o) => o.swapCount));
  const avgConviction = mean(observations.map((o) => o.conviction));

  const checks: PromotionCheck[] = [
    {
      name: "observations",
      ok: observations.length >= c.minObservations,
      detail: `${observations.length} of ${c.minObservations} required`,
    },
    {
      name: "liquidity",
      ok: medLiquidity !== undefined && medLiquidity >= c.minLiquidityUsd,
      detail:
        medLiquidity === undefined
          ? "no on-chain liquidity reading yet"
          : `median ${usd(medLiquidity)} vs floor ${usd(c.minLiquidityUsd)}`,
    },
    {
      name: "volume24h",
      ok: medVolume !== undefined && medVolume >= c.minVolume24hUsd,
      detail:
        medVolume === undefined
          ? "no 24h volume reading yet"
          : `median ${usd(medVolume)} vs floor ${usd(c.minVolume24hUsd)}`,
    },
    {
      name: "swapCount",
      ok: medSwaps !== undefined && medSwaps >= c.minSwapCount,
      detail:
        medSwaps === undefined
          ? "no swap-count reading yet"
          : `median ${medSwaps} vs floor ${c.minSwapCount} per window`,
    },
    {
      name: "conviction",
      ok: avgConviction !== undefined && avgConviction >= c.minAvgConviction,
      detail:
        avgConviction === undefined
          ? "no brain reading yet"
          : `mean ${avgConviction.toFixed(2)} vs floor ${c.minAvgConviction.toFixed(2)}`,
    },
  ];

  const passed = checks.filter((k) => k.ok).length;
  return {
    asset,
    ready: passed === checks.length,
    score: passed / checks.length,
    observations: observations.length,
    checks,
  };
}

/** Load the radar store. Never throws — a corrupt file degrades to "no history"
 *  rather than stopping the agent, exactly like the learning weights. */
export function loadRadar(): RadarStore {
  try {
    if (!existsSync(RADAR_PATH)) return {};
    const parsed = JSON.parse(readFileSync(RADAR_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as RadarStore) : {};
  } catch {
    return {};
  }
}

export function saveRadar(store: RadarStore): void {
  atomicWriteJson(RADAR_PATH, store);
}

/** Pure: append an observation to an asset's history, keeping the newest
 *  MAX_OBSERVATIONS. Returns a new store — callers persist it. */
export function recordObservation(
  store: RadarStore,
  asset: string,
  observation: RadarObservation,
): RadarStore {
  const prior = store[asset] ?? [];
  return { ...store, [asset]: [...prior, observation].slice(-MAX_OBSERVATIONS) };
}

/** Drop history for assets no longer on radar, so a removed asset's stale
 *  evidence can't resurface if it's re-added months later. */
export function pruneRadar(store: RadarStore, radar: UniverseAsset[]): RadarStore {
  const live = new Set(radar.map((a) => a.symbol));
  return Object.fromEntries(Object.entries(store).filter(([asset]) => live.has(asset)));
}
