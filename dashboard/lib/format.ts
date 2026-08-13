// Display formatters for the console.
//
// Extracted from Console.tsx so they can be tested directly: the rule they
// encode is a product requirement, not cosmetics. Signal fetches are fail-soft
// — a missing RSI or liquidity reading is legitimate and common — so every
// numeric cell must degrade to an em-dash. Rendering "undefined" or "NaN" on a
// trading console reads as a broken agent, which is worse than a blank.

/** What a missing measurement renders as. Never "undefined", never "NaN". */
export const DASH = "—";

/** Compact USD: $1.2M / $12.3k / $12.34. */
export const fmtUsd = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(2)}`;

/** Middle-truncate an address: 0x1234…cdef. */
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** BscScan transaction URL. */
export const tx = (h: string) => `https://bscscan.com/tx/${h}`;

/** A number cell, or DASH when the reading is absent/non-finite. */
export const n = (v: number | undefined | null, d = 0, pre = "", suf = "") =>
  v == null || !Number.isFinite(v) ? DASH : `${pre}${v.toFixed(d)}${suf}`;

/** A USD cell, or DASH when the reading is absent/non-finite. */
export const usd = (v: number | undefined | null) => (v == null || !Number.isFinite(v) ? DASH : fmtUsd(v));
