// Pure mappers from CoinMarketCap REST/MCP response shapes into our SignalBundle
// fields. The live network fetch lives in signals/index (guarded by a key); these
// mappers are pure so they're unit-testable against fixtures NOW, before any key
// exists. Shapes follow the documented endpoints — confirm exact nesting in the
// spike, but the defensive extraction tolerates reasonable variation.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** /v2/cryptocurrency/quotes/latest → data keyed by symbol (array or object). */
export function mapQuotePrice(raw: any, symbol: string): number | undefined {
  const entry = raw?.data?.[symbol] ?? raw?.data?.[symbol.toUpperCase()];
  const item = Array.isArray(entry) ? entry[0] : entry;
  const price = item?.quote?.USD?.price;
  return typeof price === "number" ? price : undefined;
}

/** /v2/cryptocurrency/quotes/latest → 24h traded USD volume for a symbol. */
export function mapQuoteVolume24h(raw: any, symbol: string): number | undefined {
  const entry = raw?.data?.[symbol] ?? raw?.data?.[symbol.toUpperCase()];
  const item = Array.isArray(entry) ? entry[0] : entry;
  const v = item?.quote?.USD?.volume_24h;
  return typeof v === "number" ? v : undefined;
}

/** x402 /x402/v3/cryptocurrency/quotes/latest → { data: Coin[], status }.
 *  Unlike the keyed REST quote, data is an ARRAY and quote is an ARRAY, and
 *  multiple coins can share a symbol (meme impostors). Pick the active coin with
 *  the best (lowest) cmc_rank, then its USD quote — never blindly take [0]. */
export function mapX402QuotePrice(res: any, symbol: string): number | undefined {
  const arr = res?.data;
  if (!Array.isArray(arr)) return undefined;
  const sym = symbol.toUpperCase();
  const matches = arr.filter((c: any) => String(c?.symbol).toUpperCase() === sym && c?.is_active === 1);
  const pool = matches.length ? matches : arr;
  let best: any;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const c of pool) {
    const rank = typeof c?.cmc_rank === "number" ? c.cmc_rank : Number.POSITIVE_INFINITY;
    if (rank < bestRank) {
      bestRank = rank;
      best = c;
    }
  }
  const q = best?.quote;
  const usd = Array.isArray(q) ? (q.find((x: any) => x?.symbol === "USD") ?? q[0]) : q?.USD;
  return typeof usd?.price === "number" ? usd.price : undefined;
}

/** /v3/fear-and-greed/latest → data.value (0-100). */
export function mapFearGreed(raw: any): number | undefined {
  const v = raw?.data?.value;
  return typeof v === "number" ? v : undefined;
}

/** /v2/cryptocurrency/ohlcv/historical → ascending close-price series. */
export function mapOhlcvCloses(raw: any, symbol: string): number[] {
  const entry = raw?.data?.[symbol] ?? raw?.data;
  const quotes = entry?.quotes;
  if (!Array.isArray(quotes)) return [];
  return quotes
    .map((q: any) => q?.quote?.USD?.close)
    .filter((c: any): c is number => typeof c === "number");
}

// ---- CMC MCP (Agent Hub) response parsers ----
// MCP tools return a JSON string in content[0].text; these parse the decoded
// object. Shapes captured live from the server (see commit history).

function toNum(x: unknown): number | undefined {
  const n = typeof x === "string" ? Number.parseFloat(x) : typeof x === "number" ? x : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** get_global_crypto_derivatives_metrics → fundingRate.current (string). */
export function parseFundingRate(obj: any): number | undefined {
  return toNum(obj?.fundingRate?.current);
}

/** get_global_metrics_latest → sentiment.fear_greed.current.index (0-100). */
export function parseFearGreedMcp(obj: any): number | undefined {
  const v = obj?.sentiment?.fear_greed?.current?.index;
  return typeof v === "number" ? v : undefined;
}

/** get_crypto_technical_analysis → { rsi14, macd } (string numbers). */
export function parseTechnicals(obj: any): { rsi14?: number; macd?: number } {
  return { rsi14: toNum(obj?.rsi?.rsi14), macd: toNum(obj?.macd?.macdLine) };
}

/** search_cryptos → the CMC numeric id for an exact symbol match (string). */
export function parseSearchId(arr: any, symbol: string): string | undefined {
  if (!Array.isArray(arr)) return undefined;
  const hit = arr.find((x: any) => String(x?.symbol).toUpperCase() === symbol.toUpperCase());
  const id = hit?.id ?? arr[0]?.id;
  return id !== undefined && id !== null ? String(id) : undefined;
}

/** Pull one column (by header name) from a CMC `{headers, rows}` table. Robust to
 *  column reordering. Returns up to `limit` non-empty string values. */
function columnFrom(table: any, col: string, limit: number): string[] {
  const headers = table?.headers;
  const rows = table?.rows;
  if (!Array.isArray(headers) || !Array.isArray(rows)) return [];
  const idx = headers.indexOf(col);
  if (idx < 0) return [];
  return rows
    .slice(0, limit)
    .map((r: any) => String(r?.[idx] ?? "").trim())
    .filter(Boolean);
}

/** get_crypto_latest_news → recent headline titles for the asset. */
export function parseNewsHeadlines(raw: any, limit = 3): string[] {
  return columnFrom(raw, "title", limit);
}

/** trending_crypto_narratives → top trending narrative names (social/narrative heat). */
export function parseTrendingNarratives(raw: any, limit = 5): string[] {
  return columnFrom(raw?.categoryList, "categoryName", limit);
}

/** get_upcoming_macro_events → imminent market-moving events as "title (date)". */
export function parseMacroEvents(raw: any, limit = 3): string[] {
  const t = raw?.upcomingEventNews;
  const headers = t?.headers;
  const rows = t?.rows;
  if (!Array.isArray(headers) || !Array.isArray(rows)) return [];
  const ti = headers.indexOf("title");
  const di = headers.indexOf("eventDate");
  if (ti < 0) return [];
  return rows
    .slice(0, limit)
    .map((r: any) => {
      const title = String(r?.[ti] ?? "").trim();
      const date = di >= 0 ? String(r?.[di] ?? "").trim() : "";
      return date ? `${title} (${date})` : title;
    })
    .filter((s: string) => s && s !== "()");
}

/** get_crypto_marketcap_technical_analysis → market-cap-wide RSI14 (breadth signal). */
export function parseMarketRsi(raw: any): number | undefined {
  const v = Number(raw?.rsi?.rsi14);
  return Number.isFinite(v) ? v : undefined;
}

/** /v1/dex/security/detail → treat anything flagged as a honeypot/high-risk as unsafe. */
export function mapIsHoneypot(raw: any): boolean {
  const d = raw?.data;
  const item = Array.isArray(d) ? d[0] : d;
  // Defensive: any explicit honeypot flag, or a missing/false "is_safe".
  if (item?.is_honeypot === true) return true;
  if (item?.is_safe === false) return true;
  return false;
}
