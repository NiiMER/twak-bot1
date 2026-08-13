import { config, loadConstitution } from "./config.js";
import { fetchSignalBundle } from "./signals/index.js";
import { propose } from "./brain/index.js";
import { evaluate } from "./kernel/index.js";
import { executeSwap } from "./exec/index.js";
import { append } from "./ledger/index.js";
import { detectRegime } from "./regime/index.js";
import { emptyPortfolio } from "./portfolio/index.js";
import { loadPortfolioFromChain } from "./ops/state.js";
import { recordDailyTrade } from "./ops/daily.js";
import { alert } from "./ops/heartbeat.js";
import { writeSnapshot } from "./ops/snapshot.js";
import { maybeRunDailyQualifier } from "./ops/qualifier.js";
import { startSnapshotServer } from "./ops/server.js";
import {
  computeOutcome,
  loadPositions,
  savePositions,
  type OpenPosition,
} from "./ops/positions.js";
import { applyWeights, learnFromOutcome, loadWeights, saveWeights } from "./learning/index.js";
import { canonSymbol, loadUniverse, type PromotionCriteria } from "./universe/index.js";
import { assessPromotion, loadRadar, pruneRadar, recordObservation, saveRadar } from "./radar/index.js";
import type { LedgerEntry, PortfolioState } from "./types.js";

/** Parse a positive-ish env number, falling back to default on NaN/garbage. */
function envNum(name: string, def: number, min: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : def;
}

// How long a decision is held before we grade it (and learn). Configurable so a
// demo can set it short (e.g. 60000) and watch the agent adapt quickly.
const HOLD_MS = envNum("PLIMSOLL_HOLD_MS", 3_600_000, 0); // 1h default
// Hard cap so an open decision that's never re-priced can't grow positions.json
// forever (e.g. its asset was removed from the watchlist mid-week).
const MAX_POSITION_AGE_MS = Math.max(HOLD_MS * 6, 12 * 3_600_000);

// THE TRACER BULLET (Phase 1): the thinnest end-to-end pipe, proving the layers
// compose — signal → brain → kernel → exec → ledger. Each layer is a hollow stub
// today; we thicken them one at a time (Phases 2-4), re-running this loop after
// each to confirm the pipe still flows. Build the skeleton, prove it, then fill.

// Returns the portfolio alongside the ledger row: the caller needs the equity it
// actually read, and LedgerEntry is the PERSISTED shape — not the place to bolt
// on loop-local state.
async function runOnce(
  asset: string,
  opts: { radarOnly?: boolean } = {},
): Promise<{ entry: LedgerEntry; portfolio: PortfolioState }> {
  const constitution = loadConstitution();

  // Restart-state: rebuild equity/positions from chain on every boot (never local
  // memory). Falls back to a stub if the wallet/CLI isn't reachable.
  let portfolio: PortfolioState;
  try {
    portfolio = await loadPortfolioFromChain();
    console.log(`[0/5] state    → equity $${portfolio.equityUsd.toFixed(2)} from chain (peak $${portfolio.peakEquityUsd.toFixed(2)})`);
  } catch (e) {
    // NEVER trade on fabricated equity in live mode — skip the cycle instead.
    if (config.mode === "live") {
      throw new Error(`live chain read failed — skipping cycle (won't trade blind): ${(e as Error).message}`);
    }
    portfolio = emptyPortfolio(1000); // dev/dry-run only
    console.log(`[0/5] state    → chain read failed, using $1000 stub (dev): ${(e as Error).message}`);
  }

  console.log(`\n[1/5] signals  → fetching bundle for ${asset}`);
  const bundle = await fetchSignalBundle(asset);
  const currentRegime = detectRegime(bundle);
  const currentPrice = bundle.cmc.priceUsd;

  // Resolution pass: grade any matured decision on this asset and fold the result
  // into the learned weights (the live outcome→learning loop). Runs in dry-run too.
  let weights = loadWeights();
  const now = Date.now();
  const remaining: OpenPosition[] = [];
  for (const pos of loadPositions()) {
    const age = now - pos.openedAt;
    if (pos.asset === asset && currentPrice !== undefined && currentPrice > 0 && age >= HOLD_MS) {
      const outcome = computeOutcome(pos, currentPrice, currentRegime);
      const { weights: updated, grade } = learnFromOutcome(weights, pos.regime, outcome);
      weights = updated;
      append({
        ts: new Date().toISOString(),
        bundle,
        proposal: { regime: pos.regime, asset, direction: pos.direction, conviction: 0, thesis: pos.thesis },
        decision: { ok: false, reason: "resolved" },
        outcome,
        selfGrade: grade,
      });
      console.log(
        `[learn]  ${asset} ${pos.direction}: pnl $${outcome.pnlUsd.toFixed(2)}, thesis ${outcome.thesisHeld ? "held" : "broke"}, grade ${grade.toFixed(2)} → ${pos.regime} weight ${weights.byRegime[pos.regime].toFixed(2)}`,
      );
    } else if (age >= MAX_POSITION_AGE_MS) {
      // Never priced/revisited within the bound — drop it so the file can't grow forever.
      console.log(`[learn]  dropping stale ${pos.asset} ${pos.direction} (age ${Math.round(age / 3_600_000)}h, no price to grade)`);
    } else {
      remaining.push(pos);
    }
  }
  savePositions(remaining);
  saveWeights(weights);

  console.log(`[2/5] brain    → proposing (LLM)`);
  const raw = await propose(bundle);
  const proposal = applyWeights(raw, weights); // past performance scales conviction
  console.log(
    `        regime=${proposal.regime} dir=${proposal.direction} conv=${raw.conviction}→${proposal.conviction.toFixed(2)} (learned)`,
  );

  console.log(`[3/5] kernel   → evaluating against constitution`);
  const decision = evaluate(proposal, portfolio, constitution, {
    isHoneypot: bundle.chain.isHoneypot,
    liquidityUsd: bundle.chain.liquidityUsd,
    regime: currentRegime, // deterministic regime — enforces flat-in-risk-off
    // Defense in depth: if a radar symbol ever leaks into the traded rotation,
    // the kernel refuses to open exposure rather than trusting the caller.
    radarOnly: opts.radarOnly,
  });

  const entry: LedgerEntry = { ts: new Date().toISOString(), bundle, proposal, decision };

  if (decision.ok) {
    console.log(`        approved: ${decision.order.direction} $${decision.order.sizeUsd.toFixed(2)} ${decision.order.asset}`);
    const mode = config.mode === "live" ? "LIVE execute" : "dry-run quote";
    console.log(`[4/5] exec     → TWAK swap (${mode})`);
    try {
      entry.exec = await executeSwap(decision.order);
      console.log(`        ${entry.exec.txHash}`);
      recordDailyTrade(decision.order.sizeUsd); // feed the kernel's daily-volume cap
      // Record the decision to be graded after the hold horizon (drives learning).
      // Only BUYS open a learning position — a sell is an EXIT, not a new thesis to
      // grade. (The matching buy was already recorded and is graded on its own clock.)
      if (decision.order.direction === "buy" && currentPrice !== undefined && currentPrice > 0) {
        const open = loadPositions();
        open.push({
          id: entry.ts,
          asset,
          direction: decision.order.direction,
          entryPrice: currentPrice,
          sizeUsd: decision.order.sizeUsd,
          regime: proposal.regime,
          entryRegime: currentRegime,
          thesis: proposal.thesis,
          openedAt: now,
        });
        savePositions(open);
      }
    } catch (e) {
      console.log(`        exec failed (non-fatal): ${(e as Error).message}`);
    }
  } else {
    console.log(`        rejected: ${decision.reason}`);
    console.log(`[4/5] exec     → skipped (kernel rejected)`);
  }

  console.log(`[5/5] ledger   → appended`);
  append(entry);

  // Daily-trade qualifier: if nothing has traded this UTC day (a quiet risk-off
  // tape), fire one minimal stable↔stable swap so we never miss the ≥1-trade/day
  // requirement. Best-effort — a failure here must never break the loop.
  try {
    const q = await maybeRunDailyQualifier(portfolio);
    if (q) {
      console.log(`[qualifier] daily min-trade satisfied — ${q.order.direction} $${q.order.sizeUsd} ${q.order.asset} (${q.txHash})`);
      await alert("info", `${config.mode}: daily qualifier ${q.order.direction} ${q.order.asset} → ${q.txHash}`);
    }
  } catch (e) {
    console.log(`[qualifier] failed (non-fatal): ${(e as Error).message}`);
  }

  writeSnapshot(entry, portfolio, constitution); // emit dashboard state (best-effort)
  console.log(`\n✅ cycle complete — pipe flows end to end.`);
  return { entry, portfolio };
}

/** ONE RADAR PASS — the full read path (signals → brain, so the model still
 *  weighs news, narratives and macro), then a hard stop. No kernel call, no exec,
 *  no ledger row: a radar asset produces evidence, never a transaction. What we
 *  keep is what a promotion decision needs — depth, activity, and whether the
 *  brain's read held up over time. Best-effort; never breaks the trade loop. */
async function observeRadar(asset: string, promotion: PromotionCriteria, portfolio: PortfolioState): Promise<void> {
  const bundle = await fetchSignalBundle(asset);
  const regime = detectRegime(bundle);
  const proposal = await propose(bundle);

  const store = recordObservation(loadRadar(), asset, {
    ts: new Date().toISOString(),
    priceUsd: bundle.cmc.priceUsd,
    liquidityUsd: bundle.chain.liquidityUsd,
    volume24hUsd: bundle.cmc.volume24hUsd,
    swapCount: bundle.chain.swapCount,
    isHoneypot: bundle.chain.isHoneypot,
    regime,
    direction: proposal.direction,
    conviction: proposal.conviction,
    thesis: proposal.thesis,
    news: bundle.cmc.news ?? [],
  });
  saveRadar(store);

  const a = assessPromotion(asset, store[asset] ?? [], promotion);
  const failing = a.checks.filter((k) => !k.ok).map((k) => k.name);
  console.log(
    `[radar]  ${asset} obs=${a.observations} score=${(a.score * 100).toFixed(0)}%` +
      (a.blocked ? ` BLOCKED (${a.blocked})` : failing.length ? ` pending: ${failing.join(", ")}` : " — ALL CHECKS PASS"),
  );

  // A position open on a radar asset means it was demoted while still held.
  //
  // The kernel deliberately allows EXITS on a radar asset (the veto sits after
  // the exit path) — but that guarantee is worthless unless something actually
  // asks the kernel. Previously this branch only alerted, so the position sat
  // unmanaged until a human edited universe.yaml: an unattended agent held risk
  // it had been told to stop holding. So route it through the kernel with
  // radarOnly, which can only ever return a SELL here (buys are vetoed), and
  // execute that. This is the one path on which a radar asset transacts, and it
  // strictly REDUCES exposure.
  if ((portfolio.positions[asset] ?? 0) > 0) {
    console.log(`[radar]  ⚠️  ${asset} is on RADAR with an open position — attempting a kernel-approved exit`);
    const exit = evaluate(
      { regime, asset, direction: "sell", conviction: 0, thesis: "radar demotion — flatten" },
      portfolio,
      loadConstitution(),
      { regime, radarOnly: true, isHoneypot: bundle.chain.isHoneypot, liquidityUsd: bundle.chain.liquidityUsd },
    );
    if (exit.ok && exit.order.direction === "sell") {
      try {
        const res = await executeSwap(exit.order);
        recordDailyTrade(exit.order.sizeUsd);
        const msg = `${asset} exited from RADAR (demoted while held): sell $${exit.order.sizeUsd.toFixed(2)} → ${res.txHash}`;
        console.log(`[radar]  ${msg}`);
        await alert("info", msg);
      } catch (e) {
        const msg = `${asset} is on RADAR with an open position and the exit FAILED: ${(e as Error).message}`;
        console.log(`[radar]  ⚠️  ${msg}`);
        await alert("error", msg);
      }
    } else {
      const msg = `${asset} is on RADAR with an open position but the kernel refused the exit: ${exit.ok ? "unexpected non-sell order" : exit.reason}`;
      console.log(`[radar]  ⚠️  ${msg}`);
      await alert("error", msg);
    }
  }

  if (a.ready) {
    // Evidence, not permission: promotion stays a human edit to universe.yaml.
    const msg = `${asset} has cleared every radar promotion check (${a.observations} observations). Review and move it to the watchlist in universe.yaml if you want it traded.`;
    console.log(`[radar]  ✅ ${msg}`);
    await alert("info", msg);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The unattended live-week runner. One decision per interval over a watchlist;
// every cycle is wrapped so a single failure never stops the loop, and trades /
// errors / a periodic heartbeat are pushed to Telegram (no-op if unconfigured).
// The USER launches this in live mode (`npm run dev`); it trades autonomously.
async function runContinuous(): Promise<void> {
  startSnapshotServer(); // expose the live snapshot for the dashboard (Railway domain)
  // The universe comes from universe.yaml: `watchlist` trades, `radar` is watched
  // only. A malformed file throws here — if we can't say which assets may spend
  // money, refusing to start is the right answer.
  const universe = loadUniverse();
  // canonSymbol, not raw: buildUniverse detects tier conflicts case-insensitively,
  // so a raw-cased set here would let `radar: [cake]` + PLIMSOLL_WATCHLIST=CAKE
  // slip through and trade an asset that is supposed to be observation-only.
  const radarSet = new Set(universe.radar.map((a) => canonSymbol(a.symbol)));

  // PLIMSOLL_WATCHLIST still overrides the traded tier: existing deploys pass it
  // as an env var, and an ops override shouldn't need a config-file redeploy. It
  // overrides ONLY the watchlist — radar always comes from the file.
  const envRequested = (process.env.PLIMSOLL_WATCHLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let watchlist: string[];
  let dropped: string[];
  if (envRequested.length) {
    // Drop anything outside the eligible allowlist up front — otherwise those
    // assets burn a signal fetch + LLM call every cycle only to be kernel-rejected
    // (e.g. BNB, the gas token, is not an eligible *trading* asset).
    const allow = new Set(loadConstitution().allowlist.symbols);
    watchlist = envRequested.filter((s) => allow.has(s));
    dropped = envRequested.filter((s) => !allow.has(s));
    console.log("[universe] PLIMSOLL_WATCHLIST set — overriding the universe.yaml watchlist");
  } else {
    watchlist = universe.watchlist.map((a) => a.symbol);
    dropped = universe.dropped;
  }

  // Radar wins any overlap. It's the stronger promise ("this asset does not
  // trade"), so an override that contradicts it is treated as the mistake.
  const conflicts = watchlist.filter((s) => radarSet.has(canonSymbol(s)));
  if (conflicts.length) {
    console.log(`[universe] ⚠️  also on radar, refusing to trade: ${conflicts.join(", ")}`);
    watchlist = watchlist.filter((s) => !radarSet.has(canonSymbol(s)));
  }

  if (dropped.length) console.log(`[universe] watchlist dropped (not in allowlist): ${dropped.join(", ")}`);
  if (!watchlist.length) {
    throw new Error("watchlist empty after filtering — edit universe.yaml or set PLIMSOLL_WATCHLIST to eligible tokens");
  }
  console.log(`[universe] trading ${watchlist.length}: ${watchlist.join(", ")}`);

  // Radar assets: observed one per cycle, round-robin. Each pass costs a signal
  // fetch + an LLM call, so PLIMSOLL_RADAR_EVERY throttles it on a tight budget.
  const radar = universe.radar.map((a) => a.symbol);
  const radarEvery = envNum("PLIMSOLL_RADAR_EVERY", 1, 1);
  if (radar.length) {
    console.log(`[universe] radar (observe only, never trades) ${radar.length}: ${radar.join(", ")}`);
  }
  // Prune UNCONDITIONALLY — including when the tier is now empty. Gating this on
  // radar.length meant removing the last radar asset stranded its history, and
  // re-adding that symbol later resurrected stale promotion evidence.
  try {
    saveRadar(pruneRadar(loadRadar(), universe.radar));
  } catch {
    /* radar store is evidence, not safety — never block startup on it */
  }
  const intervalMs = envNum("PLIMSOLL_INTERVAL_MS", 300_000, 1000); // 5 min, min 1s
  if (!config.telegram.botToken || !config.telegram.chatId) {
    console.log("[ops] Telegram alerts OFF — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID for live-week pings");
  }
  await alert("info", `starting (mode=${config.mode}, ${watchlist.length} assets, ${Math.round(intervalMs / 1000)}s cadence)`);
  let i = 0;
  let consecutiveFailures = 0;
  while (true) {
    const asset = watchlist[i % watchlist.length] ?? "CAKE";
    let ok = true;
    let portfolio: PortfolioState | undefined;
    try {
      const r = await runOnce(asset, { radarOnly: radarSet.has(canonSymbol(asset)) });
      const entry = r.entry;
      portfolio = r.portfolio;
      if (entry.exec) await alert("info", `${config.mode}: ${entry.proposal.direction} ${asset} → ${entry.exec.txHash}`);
    } catch (e) {
      ok = false;
      await alert("error", `cycle ${i} (${asset}) failed: ${(e as Error).message}`);
    }

    // Radar pass — one asset per eligible cycle, round-robin, fully isolated: a
    // radar failure must never affect the traded sleeve.
    if (radar.length && i % radarEvery === 0) {
      const watched = radar[Math.floor(i / radarEvery) % radar.length]!;
      try {
        await observeRadar(watched, universe.promotion, portfolio ?? emptyPortfolio(0));
      } catch (e) {
        console.log(`[radar]  ${watched} observation failed (non-fatal): ${(e as Error).message}`);
      }
    }
    if (i % 12 === 0) await alert("info", `heartbeat — cycle ${i}, watching ${asset}`);
    i++;
    // Exponential backoff on sustained failure (capped 16× = ~80 min at the 5-min
    // cadence) so an API outage doesn't hammer endpoints, but the agent still
    // recovers within the hour once it's back. Resets on a clean cycle.
    consecutiveFailures = ok ? 0 : Math.min(consecutiveFailures + 1, 4);
    await sleep(intervalMs * 2 ** consecutiveFailures);
  }
}

// Graceful shutdown: a 24/7 host (Railway) sends SIGTERM on every redeploy. Exit 0
// so it's a CLEAN stop, not a non-zero "crash" (otherwise every redeploy emails a
// false crash alert — which would mask a real crash during the live week). State is
// rebuilt from chain on the next boot, so exiting between/within cycles is safe.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`\n[shutdown] received ${sig} — stopping cleanly`);
    process.exit(0);
  });
}

// `npm run tracer` (single cycle) or `npm run dev` (continuous live-week runner).
const once = process.argv.includes("--once");
if (once) {
  runOnce("CAKE")
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("cycle failed:", e);
      process.exit(1);
    });
} else {
  runContinuous().catch((e) => {
    console.error("runner failed:", e);
    process.exit(1);
  });
}
