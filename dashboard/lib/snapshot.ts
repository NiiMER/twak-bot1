import fs from "node:fs";
import path from "node:path";
import type { Snapshot } from "./types";
import sample from "../data/sample-snapshot.json";

// Resolve the agent snapshot, in priority order:
//   1. PLIMSOLL_SNAPSHOT_URL — the agent's live HTTP endpoint (Railway). This is how
//      the Vercel-hosted dashboard shows REAL live state across hosts.
//   2. A local snapshot.json next to a co-hosted agent (PLIMSOLL_SNAPSHOT or ../).
//   3. The bundled sample — so the dashboard is still stunning with no agent.
/** Structural guard on anything claiming to be a snapshot.
 *
 *  Valid JSON is not a valid snapshot. A half-written file, a schema drift, or
 *  PLIMSOLL_SNAPSHOT_URL pointing at the wrong endpoint all yield parseable
 *  JSON that the console then dereferences into a crash — and a 500 on the
 *  dashboard looks exactly like a dead agent. Anything that fails this check is
 *  treated as "no snapshot" and falls through to the next tier. */
export function isSnapshot(v: unknown): v is Snapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, never>;

  const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  const str = (x: unknown) => typeof x === "string";
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  // Checking only that a block is an object is not enough: `agent: {}` passes
  // that, and the console then calls short(agent.wallet) → undefined.slice, or
  // .toFixed on a missing number — the same 500 this guard exists to prevent.
  // So verify the fields the console actually dereferences, with their types.
  const has = (block: unknown, checks: Record<string, (x: unknown) => boolean>) =>
    obj(block) && Object.entries(checks).every(([k, ok]) => ok(block[k]));

  return (
    has(s.agent, { name: str, mode: str, wallet: str, agentId: str, registry: str, constitutionHash: str }) &&
    has(s.latestDecision, {
      asset: str,
      regime: str,
      direction: str,
      conviction: num,
      thesis: str,
      sizeUsd: num,
      kernelReason: str,
    }) &&
    has(s.signals, { cmc: obj, chain: obj }) &&
    has(s.portfolio, { equityUsd: num, peakEquityUsd: num, drawdownPct: num }) &&
    // The sparkline maps i / (length - 1); a single point divides by zero and a
    // zero-length curve takes min/max of nothing — both yield NaN SVG geometry.
    Array.isArray((s.portfolio as Record<string, unknown>).equityCurve) &&
    ((s.portfolio as Record<string, unknown>).equityCurve as unknown[]).length >= 2 &&
    ((s.portfolio as Record<string, unknown>).equityCurve as unknown[]).every((p) => has(p, { equity: num })) &&
    has(s.guardrails, {
      allowlist: num,
      perTradePct: num,
      dailyPct: num,
      slippageBps: num,
      liquidityFloorUsd: num,
      killSwitchPct: num,
      dqPct: num,
    }) &&
    has(s.learning, { trending: num, chopping: num, risk_off: num }) &&
    Array.isArray(s.ledger) &&
    has(s.backtest, {
      asset: str,
      candles: num,
      buyHoldPct: num,
      strategyPct: num,
      grossPct: num,
      maxDdPct: num,
      trades: num,
      winRatePct: num,
    }) &&
    has(s.proof, { swapTx: str, registerTx: str, setMetadataTx: str, competeTx: str }) &&
    num(s.cycle)
  );
}

export async function loadSnapshot(): Promise<{ snap: Snapshot; live: boolean }> {
  const url = process.env.PLIMSOLL_SNAPSHOT_URL;
  if (url) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const body = await res.json();
        if (isSnapshot(body)) return { snap: body, live: true };
      }
    } catch {
      /* agent unreachable → fall through */
    }
  }

  const p = process.env.PLIMSOLL_SNAPSHOT || path.join(process.cwd(), "..", "snapshot.json");
  try {
    if (fs.existsSync(p)) {
      const body = JSON.parse(fs.readFileSync(p, "utf8"));
      if (isSnapshot(body)) return { snap: body, live: true };
    }
  } catch {
    /* fall through to the bundled sample */
  }
  return { snap: sample as Snapshot, live: false };
}
