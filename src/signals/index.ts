import { config } from "../config.js";
import { resolveBscToken } from "../tokens/index.js";
import { cachedTTL } from "../util/cache.js";
import { mapFearGreed, mapQuotePrice, mapQuoteVolume24h } from "./cmc.js";
import { fetchChainSignals, type ChainSignals } from "./chain.js";
import { checkHoneypot } from "./honeypot.js";
import { fetchMcpSignals, type McpSignals } from "./mcp.js";
import { fetchX402Price } from "./x402.js";
import type { SignalBundle } from "../types.js";

// DATA / EDGE LAYER. Price comes from the CMC REST API (free Basic key); funding
// rate, Fear & Greed, and technicals (RSI/MACD) come from the CMC Agent Hub via
// MCP (free MCP tier) — which also scores "Best Use of Agent Hub". Every source
// is independent and tolerates failure: a 24/7 agent must degrade gracefully (a
// missing field just falls back to the regime detector's neutral default).
//
// Still pending the TWAK spike: chain-native DEX signals + paying ≥1 source
// per-call via `twak x402` (R1).

async function cmcGet(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(config.cmc.restBase + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "X-CMC_PRO_API_KEY": config.cmc.apiKey, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CMC ${path} → HTTP ${res.status}`);
  return res.json();
}

export async function fetchSignalBundle(asset: string): Promise<SignalBundle> {
  const bundle: SignalBundle = {
    timestamp: new Date().toISOString(),
    asset,
    cmc: {},
    chain: {},
    paidViaX402: false,
  };

  if (!config.cmc.apiKey) return bundle; // keyless → hollow bundle; rule engine still runs

  // Market-wide REST F&G is only a fallback for the MCP value — cache it so it isn't
  // re-fetched every cycle/asset (same TTL rationale as the MCP globals).
  const GLOBALS_TTL_MS = Number(process.env.CMC_GLOBALS_TTL_MS) || 15 * 60 * 1000;
  const [restFearGreed, mcp] = await Promise.all([
    cachedTTL("cmc:rest:feargreed", GLOBALS_TTL_MS, () =>
      cmcGet("/v3/fear-and-greed/latest", {}).then(mapFearGreed),
    ).catch(() => undefined), // REST F&G is just a fallback for MCP
    fetchMcpSignals(asset).catch((e): McpSignals => {
      console.warn(`  ⚠️  MCP signals failed: ${(e as Error).message}`);
      return {};
    }),
  ]);

  // Price: in LIVE mode the agent pays for it via x402 (R1 — funds its own data);
  // otherwise (and as a fallback) the free REST quote.
  let price: number | undefined;
  if (config.mode === "live") {
    price = await fetchX402Price(asset).catch((e) => {
      console.warn(`  ⚠️  x402 price failed, falling back to REST: ${(e as Error).message}`);
      return undefined;
    });
    if (price !== undefined) bundle.paidViaX402 = true;
  }
  // Hold the raw quote so 24h volume comes off the SAME response as the price —
  // one call, two fields.
  let quoteRaw: unknown;
  if (price === undefined) {
    quoteRaw = await cmcGet("/v2/cryptocurrency/quotes/latest", { symbol: asset }).catch((e) => {
      console.warn(`  ⚠️  quotes/latest failed: ${(e as Error).message}`);
      return undefined;
    });
    if (quoteRaw !== undefined) price = mapQuotePrice(quoteRaw, asset);
  }

  bundle.cmc.priceUsd = price;
  // 24h volume — depth-of-interest, and the strongest promotion signal for a radar
  // asset. Free when we already fetched the quote above; on the live x402 path we
  // never do, so fall back to a cached read. Volume is a slow 24h aggregate, so a
  // TTL'd value is honest here and keeps the credit cost flat.
  bundle.cmc.volume24hUsd =
    quoteRaw !== undefined
      ? mapQuoteVolume24h(quoteRaw, asset)
      : await cachedTTL(`cmc:vol24h:${asset}`, GLOBALS_TTL_MS, () =>
          cmcGet("/v2/cryptocurrency/quotes/latest", { symbol: asset }).then((r) => mapQuoteVolume24h(r, asset)),
        ).catch(() => undefined);
  bundle.cmc.fearGreed = mcp.fearGreed ?? restFearGreed;
  bundle.cmc.fundingRate = mcp.fundingRate;
  bundle.cmc.rsi = mcp.rsi;
  bundle.cmc.macd = mcp.macd;
  // Breadth (CMC Agent Hub): market-wide RSI + news/narratives/macro context.
  // These feed the LLM brain's reasoning; the deterministic kernel is unaffected.
  bundle.cmc.marketRsi = mcp.marketRsi;
  bundle.cmc.news = mcp.news;
  bundle.cmc.narratives = mcp.narratives;
  bundle.cmc.macroEvents = mcp.macroEvents;

  // Chain-native: on-chain DEX liquidity for the asset (safety gate). Reads the
  // PancakeSwap pair directly via RPC; undefined = unverified (caller won't block).
  try {
    const [bnbPrice, assetAddr] = await Promise.all([
      // BNB price is only used to value pool liquidity in USD — market-wide and
      // slow-moving, so cache it rather than fetch every cycle/asset.
      cachedTTL("cmc:price:BNB", GLOBALS_TTL_MS, () =>
        cmcGet("/v2/cryptocurrency/quotes/latest", { symbol: "BNB" }).then((r) => mapQuotePrice(r, "BNB")),
      ).catch(() => undefined),
      resolveBscToken(asset).catch(() => undefined),
    ]);
    if (assetAddr?.startsWith("0x")) {
      // Liquidity/flow (needs BNB price) + honeypot run in parallel — both keyed
      // off the resolved token address. Honeypot is the pre-buy safety check.
      const [chain, hp] = await Promise.all([
        bnbPrice ? fetchChainSignals(assetAddr, bnbPrice) : Promise.resolve<ChainSignals>({}),
        checkHoneypot(assetAddr),
      ]);
      bundle.chain.liquidityUsd = chain.liquidityUsd;
      bundle.chain.swapCount = chain.swapCount;
      bundle.chain.dexImbalance = chain.dexImbalance;
      bundle.chain.walletFlow = chain.walletFlowUsd;
      // Only assert a verdict when the check succeeded; unverified stays undefined
      // (fail-open → not blocked, consistent with the liquidity gate).
      if (hp.checked) bundle.chain.isHoneypot = hp.isHoneypot;
    }
  } catch {
    /* unverified chain signals — leave undefined */
  }
  return bundle;
}
