import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// loadSnapshot decides what the whole console renders, with a three-tier
// fallback: live agent URL → co-hosted file → bundled sample. Every fallback
// edge is an "agent is down" path, so each one is tested explicitly — the
// dashboard must degrade to the sample rather than crash or show a blank page.

const { existsSync, readFileSync } = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: { existsSync, readFileSync },
  existsSync,
  readFileSync,
}));

// Structurally complete enough to pass the guard — only `agent.name` varies so
// tests can tell which tier the data came from.
function wellFormed(name: string) {
  return {
    agent: { name, mode: "live", wallet: "0xabc", agentId: "1", registry: "0xreg", constitutionHash: "0xhash" },
    asOf: "2026-08-13T00:00:00Z",
    cycle: 1,
    latestDecision: {
      asset: "CAKE",
      regime: "trending",
      direction: "buy",
      conviction: 0.5,
      thesis: "t",
      sizeUsd: 1,
      approved: true,
      kernelReason: "ok",
    },
    signals: { cmc: {}, chain: {} },
    portfolio: {
      equityUsd: 1,
      peakEquityUsd: 1,
      drawdownPct: 0,
      equityCurve: [
        { t: "a", equity: 1 },
        { t: "b", equity: 2 },
      ],
    },
    learning: { trending: 1, chopping: 1, risk_off: 1 },
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
    ledger: [],
    backtest: {
      asset: "CAKE",
      candles: 1,
      buyHoldPct: 0,
      strategyPct: 0,
      grossPct: 0,
      maxDdPct: 0,
      trades: 0,
      winRatePct: 0,
    },
    proof: { swapTx: "0x1", registerTx: "0x2", setMetadataTx: "0x3", competeTx: "0x4" },
  };
}

const REMOTE = wellFormed("from-url");
const LOCAL = wellFormed("from-file");

async function load() {
  // Re-import per test so module state and env are read fresh.
  const mod = await import("@/lib/snapshot");
  return mod.loadSnapshot();
}

beforeEach(() => {
  vi.resetModules();
  existsSync.mockReset();
  readFileSync.mockReset();
  delete process.env.PLIMSOLL_SNAPSHOT_URL;
  delete process.env.PLIMSOLL_SNAPSHOT;
  existsSync.mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadSnapshot — tier 1: live agent URL", () => {
  it("uses the URL when it responds, and marks the data live", async () => {
    process.env.PLIMSOLL_SNAPSHOT_URL = "http://agent.test/snapshot";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => REMOTE });
    vi.stubGlobal("fetch", fetchMock);

    const { snap, live } = await load();
    expect(live).toBe(true);
    expect((snap as unknown as typeof REMOTE).agent.name).toBe("from-url");
  });

  it("bypasses caching so the console never pins a stale cycle", async () => {
    process.env.PLIMSOLL_SNAPSHOT_URL = "http://agent.test/snapshot";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => REMOTE });
    vi.stubGlobal("fetch", fetchMock);

    await load();
    expect(fetchMock).toHaveBeenCalledWith("http://agent.test/snapshot", { cache: "no-store" });
  });

  it("falls through to the next tier when the agent is unreachable", async () => {
    process.env.PLIMSOLL_SNAPSHOT_URL = "http://agent.test/snapshot";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(LOCAL));

    const { snap, live } = await load();
    expect(live).toBe(true);
    expect((snap as unknown as typeof LOCAL).agent.name).toBe("from-file");
  });

  it("falls through on a non-OK response (a 502 is not a snapshot)", async () => {
    process.env.PLIMSOLL_SNAPSHOT_URL = "http://agent.test/snapshot";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));

    const { live } = await load();
    expect(live).toBe(false); // no file either → bundled sample
  });

  it("falls through when the response is ok but the body isn't valid JSON", async () => {
    // A 200 that can't be parsed (e.g. an HTML error page behind a proxy) must
    // degrade to the sample, not throw out of loadSnapshot.
    process.env.PLIMSOLL_SNAPSHOT_URL = "http://agent.test/snapshot";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => Promise.reject(new SyntaxError("bad json")) }),
    );

    const { live } = await load();
    expect(live).toBe(false);
  });
});

describe("loadSnapshot — tier 2: co-hosted file", () => {
  it("reads PLIMSOLL_SNAPSHOT when set", async () => {
    process.env.PLIMSOLL_SNAPSHOT = "/tmp/snap.json";
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify(LOCAL));

    const { snap, live } = await load();
    expect(existsSync).toHaveBeenCalledWith("/tmp/snap.json");
    expect(live).toBe(true);
    expect((snap as unknown as typeof LOCAL).agent.name).toBe("from-file");
  });

  it("degrades to the sample when the file is corrupt rather than throwing", async () => {
    process.env.PLIMSOLL_SNAPSHOT = "/tmp/snap.json";
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("{ not json");

    const { snap, live } = await load();
    expect(live).toBe(false);
    expect(snap.agent.name).toBeDefined(); // bundled sample, page still renders
  });
});

describe("isSnapshot — structural guard", () => {
  it("accepts a well-formed snapshot", async () => {
    const { isSnapshot } = await import("@/lib/snapshot");
    expect(isSnapshot(wellFormed("ok"))).toBe(true);
  });

  it("rejects non-objects", async () => {
    const { isSnapshot } = await import("@/lib/snapshot");
    for (const v of [null, undefined, 42, "snapshot", true, []]) expect(isSnapshot(v)).toBe(false);
  });

  it("rejects valid JSON that is not a snapshot", async () => {
    const { isSnapshot } = await import("@/lib/snapshot");
    expect(isSnapshot({ totally: "not a snapshot" })).toBe(false);
  });

  it("rejects a snapshot missing any block the console dereferences", async () => {
    const { isSnapshot } = await import("@/lib/snapshot");
    for (const key of [
      "agent",
      "latestDecision",
      "signals",
      "portfolio",
      "guardrails",
      "learning",
      "ledger",
      "backtest",
      "proof",
    ]) {
      const partial = wellFormed("x") as Record<string, unknown>;
      delete partial[key];
      expect(isSnapshot(partial), `missing ${key} must be rejected`).toBe(false);
    }
  });

  it("rejects an empty equity curve — the sparkline would compute NaN geometry", async () => {
    const { isSnapshot } = await import("@/lib/snapshot");
    const s = wellFormed("x");
    s.portfolio.equityCurve = [];
    expect(isSnapshot(s)).toBe(false);
  });

  it("rejects a portfolio whose equityCurve isn't an array at all", async () => {
    // A schema-drifted payload could send equityCurve as an object/number instead
    // of a list; Array.isArray must gate it before the sparkline ever sees it.
    const { isSnapshot } = await import("@/lib/snapshot");
    const s = wellFormed("x") as unknown as { portfolio: { equityCurve: unknown } };
    s.portfolio.equityCurve = "not-an-array";
    expect(isSnapshot(s)).toBe(false);
  });
});

describe("loadSnapshot — structurally invalid payloads", () => {
  it("falls back when the agent serves parseable JSON of the wrong shape", async () => {
    // The crash this prevents: a partial snapshot renders, then the console
    // dereferences latestDecision.asset and the whole page 500s.
    process.env.PLIMSOLL_SNAPSHOT_URL = "http://agent.test/snapshot";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agent: { name: "partial" } }) }));

    const { snap, live } = await load();
    expect(live).toBe(false);
    expect(snap.latestDecision).toBeDefined(); // bundled sample, page still renders
  });

  it("falls back when the co-hosted file is mid-write / truncated", async () => {
    process.env.PLIMSOLL_SNAPSHOT = "/tmp/snap.json";
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ agent: { name: "half" }, portfolio: {} }));

    const { live } = await load();
    expect(live).toBe(false);
  });
});

describe("loadSnapshot — tier 3: bundled sample", () => {
  it("returns the sample and reports live:false when nothing else resolves", async () => {
    const { snap, live } = await load();
    expect(live).toBe(false);
    // The sample must be complete enough to render every panel.
    expect(snap.agent).toBeDefined();
    expect(snap.latestDecision).toBeDefined();
    expect(snap.portfolio.equityCurve.length).toBeGreaterThan(1);
    expect(snap.guardrails).toBeDefined();
    expect(snap.ledger.length).toBeGreaterThan(0);
  });

  it("never rejects — the page must render even with no agent at all", async () => {
    process.env.PLIMSOLL_SNAPSHOT_URL = "http://agent.test/snapshot";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    existsSync.mockImplementation(() => {
      throw new Error("fs exploded");
    });

    await expect(load()).resolves.toMatchObject({ live: false });
  });
});
