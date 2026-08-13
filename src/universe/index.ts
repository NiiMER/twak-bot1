import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { loadConstitution } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// THE UNIVERSE LAYER — reads universe.yaml into the two tiers the agent runs on.
//
//   watchlist → traded
//   radar     → observed only; the kernel refuses to open exposure on these
//
// The tier is a POLICY fact, decided here and handed to the kernel, which does
// the enforcing. Keeping the file declarative means changing what the agent
// trades is a config edit + restart, not a code change — and the diff is
// reviewable, which matters when the thing being edited spends real money.

/** Default promotion criteria — used when universe.yaml omits `radarPromotion`. */
export const DEFAULT_PROMOTION: PromotionCriteria = {
  minObservations: 12,
  minLiquidityUsd: 250_000,
  minVolume24hUsd: 5_000_000,
  minSwapCount: 25,
  minAvgConviction: 0.35,
};

export interface PromotionCriteria {
  minObservations: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minSwapCount: number;
  minAvgConviction: number;
}

export interface UniverseAsset {
  symbol: string;
  note?: string;
}

export interface Universe {
  version: number;
  /** Traded. Already filtered to the constitution's eligible allowlist. */
  watchlist: UniverseAsset[];
  /** Observed only. NOT allowlist-filtered — watching an ineligible asset is the point. */
  radar: UniverseAsset[];
  /** Watchlist symbols dropped because they aren't allowlist-eligible. */
  dropped: string[];
  promotion: PromotionCriteria;
}

// A tier entry is either a bare symbol or a {symbol, note} object — both normalize
// to UniverseAsset so the rest of the system sees one shape.
const AssetEntrySchema = z.union([
  z.string().min(1),
  z.object({ symbol: z.string().min(1), note: z.string().optional() }),
]);

const PromotionSchema = z.object({
  minObservations: z.number().int().nonnegative(),
  minLiquidityUsd: z.number().nonnegative(),
  minVolume24hUsd: z.number().nonnegative(),
  minSwapCount: z.number().nonnegative(),
  minAvgConviction: z.number().min(0).max(1),
});

// .strict() on purpose: a typo'd key (`watchList:`) would otherwise be stripped
// silently, leaving an empty traded tier — or worse, an ignored radar tier. YAML
// has real comments, so there's no reason to tolerate unknown keys here.
const UniverseSchema = z
  .object({
    version: z.number().int().positive(),
    watchlist: z.array(AssetEntrySchema).default([]),
    radar: z.array(AssetEntrySchema).default([]),
    radarPromotion: PromotionSchema.partial().strict().optional(),
  })
  .strict();

function normalize(entry: z.infer<typeof AssetEntrySchema>): UniverseAsset {
  return typeof entry === "string" ? { symbol: entry.trim() } : { symbol: entry.symbol.trim(), note: entry.note };
}

/** First duplicate symbol in a tier, or undefined. Case-insensitive: a config
 *  holding both "cake" and "CAKE" is a mistake, not two assets. */
function firstDuplicate(assets: UniverseAsset[]): string | undefined {
  const seen = new Set<string>();
  for (const a of assets) {
    const key = a.symbol.toUpperCase();
    if (seen.has(key)) return a.symbol;
    seen.add(key);
  }
  return undefined;
}

/** Pure: validate a parsed universe object against the eligible allowlist.
 *  Throws on a config error the operator must fix; drops (with a record) only
 *  the case the kernel would reject anyway. */
export function buildUniverse(raw: unknown, allowlist: string[]): Universe {
  const parsed = UniverseSchema.parse(raw);
  const watchlist = parsed.watchlist.map(normalize);
  const radar = parsed.radar.map(normalize);

  // A symbol in both tiers is ambiguous about the one thing that matters — may
  // this spend money? Refuse to guess.
  const radarSet = new Set(radar.map((a) => a.symbol.toUpperCase()));
  const both = watchlist.find((a) => radarSet.has(a.symbol.toUpperCase()));
  if (both) {
    throw new Error(
      `universe: ${both.symbol} is in BOTH watchlist and radar — a symbol is either traded or observed, not both`,
    );
  }

  for (const [tier, assets] of [
    ["watchlist", watchlist],
    ["radar", radar],
  ] as const) {
    const dupe = firstDuplicate(assets);
    if (dupe) throw new Error(`universe: ${dupe} listed twice in ${tier}`);
  }

  // Watchlist must be allowlist-eligible; anything else burns a signal fetch and
  // an LLM call every cycle only to be kernel-rejected. Drop it loudly instead.
  const allow = new Set(allowlist);
  const eligible = watchlist.filter((a) => allow.has(a.symbol));
  const dropped = watchlist.filter((a) => !allow.has(a.symbol)).map((a) => a.symbol);

  return {
    version: parsed.version,
    watchlist: eligible,
    radar,
    dropped,
    promotion: { ...DEFAULT_PROMOTION, ...(parsed.radarPromotion ?? {}) },
  };
}

/** Read + validate universe.yaml. Throws with the file path on a bad config —
 *  a malformed universe means we don't know what may trade, so failing to start
 *  is the correct outcome. */
export function loadUniverse(path = join(__dirname, "..", "..", "universe.yaml")): Universe {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`universe: cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return buildUniverse(raw, loadConstitution().allowlist.symbols);
  } catch (e) {
    throw new Error(`${(e as Error).message} (in ${path})`);
  }
}
