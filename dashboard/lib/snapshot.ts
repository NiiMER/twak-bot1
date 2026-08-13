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
  const s = v as Partial<Snapshot>;
  const obj = (x: unknown) => !!x && typeof x === "object";
  return (
    obj(s.agent) &&
    obj(s.latestDecision) &&
    obj(s.signals) &&
    obj(s.portfolio) &&
    // The sparkline divides by (length - 1) and takes min/max — an empty curve
    // produces NaN geometry rather than an empty chart.
    Array.isArray(s.portfolio?.equityCurve) &&
    s.portfolio!.equityCurve.length > 0 &&
    obj(s.guardrails) &&
    obj(s.learning) &&
    Array.isArray(s.ledger) &&
    obj(s.backtest) &&
    obj(s.proof)
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
