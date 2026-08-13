import { describe, expect, it } from "vitest";
import { DASH, fmtUsd, n, short, tx, usd } from "@/lib/format";

// The console renders live agent state. Signal fetches are fail-soft, so the
// "missing reading" path is a NORMAL path, not an error path — it gets the same
// scrutiny as the happy one.

describe("fmtUsd", () => {
  it("scales into k and M at the thresholds", () => {
    expect(fmtUsd(12.34)).toBe("$12.34");
    expect(fmtUsd(999.99)).toBe("$999.99");
    expect(fmtUsd(1_000)).toBe("$1.0k");
    expect(fmtUsd(12_345)).toBe("$12.3k");
    expect(fmtUsd(999_999)).toBe("$1000.0k");
    expect(fmtUsd(1_000_000)).toBe("$1.0M");
    expect(fmtUsd(2_500_000)).toBe("$2.5M");
  });

  it("handles zero", () => {
    expect(fmtUsd(0)).toBe("$0.00");
  });

  it("renders negatives in full rather than scaling them", () => {
    // Documents current behaviour: the scaling branches are `>=`, so negatives
    // always fall through to the plain branch. Equity/liquidity are never
    // negative; PnL is formatted separately with its own sign handling.
    expect(fmtUsd(-5_000)).toBe("$-5000.00");
  });
});

describe("n (number cell)", () => {
  it("formats to the requested precision with prefix and suffix", () => {
    expect(n(42)).toBe("42");
    expect(n(42.567, 2)).toBe("42.57");
    expect(n(1.5, 4, "$")).toBe("$1.5000");
    expect(n(12, 0, "", "%")).toBe("12%");
  });

  it("returns the em-dash for every flavour of 'no reading'", () => {
    expect(n(undefined)).toBe(DASH);
    expect(n(null)).toBe(DASH);
    expect(n(Number.NaN)).toBe(DASH);
    expect(n(Number.POSITIVE_INFINITY)).toBe(DASH);
    expect(n(Number.NEGATIVE_INFINITY)).toBe(DASH);
  });

  it("does NOT treat 0 as missing — a real zero must render", () => {
    // Falsy-vs-nullish is the bug this guards: a funding rate of exactly 0 is a
    // measurement, not an absence.
    expect(n(0)).toBe("0");
    expect(n(0, 2, "$")).toBe("$0.00");
  });

  it("never renders the strings 'undefined' or 'NaN'", () => {
    for (const v of [undefined, null, Number.NaN]) {
      expect(n(v)).not.toMatch(/undefined|NaN/);
    }
  });

  it("renders negative zero as a plain zero, not a signed reading", () => {
    // -0 is finite and not nullish, so it takes the happy path — but a stray
    // "-0" on the console would misleadingly read as a negative measurement.
    expect(n(-0)).toBe("0");
  });
});

describe("usd (USD cell)", () => {
  it("delegates to fmtUsd when a reading exists", () => {
    expect(usd(1_500)).toBe("$1.5k");
    expect(usd(0)).toBe("$0.00");
  });

  it("returns the em-dash when the reading is absent or non-finite", () => {
    expect(usd(undefined)).toBe(DASH);
    expect(usd(null)).toBe(DASH);
    expect(usd(Number.NaN)).toBe(DASH);
    expect(usd(Number.POSITIVE_INFINITY)).toBe(DASH);
  });

  it("delegates negatives through to fmtUsd's plain (unscaled) branch", () => {
    expect(usd(-5_000)).toBe("$-5000.00");
  });
});

describe("short (address truncation)", () => {
  it("keeps the leading 0x+4 and the trailing 4", () => {
    expect(short("0xB848C0315997B683F702fd877Ce220293CFda1e5")).toBe("0xB848…a1e5");
  });

  it("does not throw on a string shorter than the window", () => {
    expect(() => short("0x12")).not.toThrow();
  });
});

describe("tx (BscScan link)", () => {
  it("builds a mainnet BscScan transaction URL", () => {
    expect(tx("0xabc")).toBe("https://bscscan.com/tx/0xabc");
  });
});
