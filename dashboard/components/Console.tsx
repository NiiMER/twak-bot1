"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import type { Regime, Snapshot } from "@/lib/types";
import { DASH, fmtUsd, n, short, tx, usd } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// PLIMSOLL Command — instrument-grade console. The AI proposes, the deterministic
// kernel decides, Trust Wallet signs, the agent learns. Bounded + verifiable.
// ─────────────────────────────────────────────────────────────────────────────

const REGIME: Record<Regime, { label: string; color: string }> = {
  trending: { label: "TRENDING", color: "#5DD39E" },
  chopping: { label: "CHOPPING", color: "#E8B84B" },
  risk_off: { label: "RISK-OFF", color: "#E8635D" },
};

const PIPE = [
  { k: "STATE", d: "equity from chain (TWAK)" },
  { k: "SIGNALS", d: "CMC ×8 + on-chain" },
  { k: "BRAIN", d: "Claude proposes" },
  { k: "KERNEL", d: "deterministic gate" },
  { k: "EXEC", d: "TWAK signs · self-custody" },
  { k: "LEDGER", d: "trace + learn" },
] as const;

// Formatters live in lib/format so they're unit-testable on their own. Missing
// signals are legitimate (fail-soft fetch) — they render a clean em-dash, never
// "undefined". See lib/format.ts.

function Panel({
  title,
  tag,
  children,
  delay = 0,
  className = "",
}: {
  title: string;
  tag?: string;
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className={`relative bg-panel/70 hairline backdrop-blur-sm ${className}`}
    >
      {/* corner ticks */}
      <span className="pointer-events-none absolute left-0 top-0 h-2 w-2 border-l border-t border-signal/40" />
      <span className="pointer-events-none absolute bottom-0 right-0 h-2 w-2 border-b border-r border-signal/40" />
      <header className="flex items-center justify-between border-b border-hair px-4 py-2">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-fog">{title}</h2>
        {tag && <span className="font-mono text-[10px] uppercase tracking-widest text-signal/80">{tag}</span>}
      </header>
      <div className="p-4">{children}</div>
    </motion.section>
  );
}

function RegimeBadge({ r, size = "sm" }: { r: Regime; size?: "sm" | "lg" }) {
  const { label, color } = REGIME[r];
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono uppercase tracking-widest ${size === "lg" ? "text-sm" : "text-[10px]"}`}
      style={{ color }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      {label}
    </span>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: string; accent?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-fog">{label}</div>
      <div className="tnum font-mono text-lg leading-none" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub && <div className="font-mono text-[10px] text-fog/70">{sub}</div>}
    </div>
  );
}

// ── Pipeline: the separation-of-powers, live ────────────────────────────────
function Pipeline({ snap }: { snap: Snapshot }) {
  const approved = snap.latestDecision.approved;
  // STATE/SIGNALS/BRAIN always run; KERNEL is the decision point; EXEC/LEDGER only if approved.
  const reached = (i: number) => (i <= 3 ? true : approved);
  return (
    <ol className="flex flex-col gap-0">
      {PIPE.map((s, i) => {
        const live = reached(i);
        const isKernel = s.k === "KERNEL";
        const kernelColor = approved ? "#5DD39E" : "#E8635D";
        return (
          <li key={s.k} className="relative flex items-start gap-3 pb-3 last:pb-0">
            {/* connector */}
            {i < PIPE.length - 1 && (
              <span
                className="absolute left-[7px] top-4 h-full w-px"
                style={{ background: live ? "rgba(184,255,60,0.25)" : "#1E2A26" }}
              />
            )}
            <span
              className="relative mt-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full"
              style={{
                background: isKernel ? kernelColor : live ? "#B8FF3C" : "#1E2A26",
                boxShadow: live ? `0 0 10px ${isKernel ? kernelColor : "#B8FF3C"}` : "none",
              }}
            >
              {isKernel && <span className="h-1.5 w-1.5 rounded-full bg-ink" />}
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={`font-display text-sm font-semibold tracking-wide ${live ? "text-bone" : "text-fog/50"}`}
                >
                  {s.k}
                </span>
                {isKernel && (
                  <span
                    className="font-mono text-[10px] uppercase tracking-widest"
                    style={{ color: kernelColor }}
                  >
                    {approved ? "▸ approved" : "▪ held / veto"}
                  </span>
                )}
              </div>
              <div className="font-mono text-[10px] text-fog/70">{s.d}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── Conviction gauge ─────────────────────────────────────────────────────────
function Conviction({ value, regime }: { value: number; regime: Regime }) {
  const segs = 24;
  const filled = Math.round(value * segs);
  const color = REGIME[regime].color;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fog">conviction</span>
        <span className="tnum font-mono text-sm" style={{ color }}>
          {(value * 100).toFixed(0)}%
        </span>
      </div>
      <div className="flex gap-[3px]">
        {Array.from({ length: segs }).map((_, i) => (
          <motion.span
            key={i}
            initial={{ opacity: 0.15, scaleY: 0.4 }}
            animate={{ opacity: i < filled ? 1 : 0.15, scaleY: 1 }}
            transition={{ delay: 0.5 + i * 0.012 }}
            className="h-5 flex-1 origin-bottom"
            style={{ background: i < filled ? color : "#1E2A26" }}
          />
        ))}
      </div>
    </div>
  );
}

// ── Equity sparkline + drawdown vs kill-switch / DQ ──────────────────────────
function Equity({ snap }: { snap: Snapshot }) {
  const pts = snap.portfolio.equityCurve;
  const ys = pts.map((p) => p.equity);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const W = 100;
  const H = 34;
  const path = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * W;
      const y = H - ((p.equity - min) / Math.max(1, max - min)) * H;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const dd = snap.portfolio.drawdownPct;
  const { killSwitchPct, dqPct } = snap.guardrails;
  const ddColor = dd >= killSwitchPct ? "#E8635D" : dd >= killSwitchPct * 0.6 ? "#E8B84B" : "#B8FF3C";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between">
        <Stat label="equity" value={fmtUsd(snap.portfolio.equityUsd)} sub={`peak ${fmtUsd(snap.portfolio.peakEquityUsd)}`} />
        <Stat label="cycle" value={`#${snap.cycle}`} sub="per cycle" />
      </div>
      {snap.pnl && (
        <div className="flex items-end justify-between border-t border-hair pt-3">
          <Stat
            label="invested"
            value={fmtUsd(snap.pnl.startEquityUsd)}
            sub={snap.pnl.windowStarted ? "window start" : "window opens Jun 22"}
          />
          <Stat
            label="PnL"
            value={`${snap.pnl.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(snap.pnl.pnlUsd).toFixed(2)}`}
            sub={`${snap.pnl.pnlPct >= 0 ? "+" : "−"}${Math.abs(snap.pnl.pnlPct).toFixed(2)}% · net of costs`}
            accent={snap.pnl.pnlUsd >= 0 ? "#5DD39E" : "#E8635D"}
          />
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-16 w-full">
        <defs>
          <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#B8FF3C" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#B8FF3C" stopOpacity="0" />
          </linearGradient>
        </defs>
        <motion.path
          d={`${path} L${W},${H} L0,${H} Z`}
          fill="url(#eq)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.8 }}
        />
        <motion.path
          d={path}
          fill="none"
          stroke="#B8FF3C"
          strokeWidth="0.8"
          vectorEffect="non-scaling-stroke"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ delay: 0.4, duration: 1.1, ease: "easeInOut" }}
        />
      </svg>
      {/* drawdown vs kill-switch (20%) vs DQ (30%) */}
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fog">drawdown</span>
          <span className="tnum font-mono text-xs" style={{ color: ddColor }}>
            {dd.toFixed(1)}%
          </span>
        </div>
        <div className="relative h-2 w-full bg-hair/60">
          <motion.div
            className="absolute left-0 top-0 h-full"
            style={{ background: ddColor }}
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, (dd / dqPct) * 100)}%` }}
            transition={{ delay: 0.7, duration: 0.8 }}
          />
          {/* kill-switch marker */}
          <span
            className="absolute top-[-2px] h-3 w-px bg-chop"
            style={{ left: `${(killSwitchPct / dqPct) * 100}%` }}
            title={`kill-switch ${killSwitchPct}%`}
          />
          {/* DQ line at the far right */}
          <span className="absolute right-0 top-[-2px] h-3 w-px bg-risk" title={`DQ ${dqPct}%`} />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[9px] text-fog/60">
          <span>0%</span>
          <span className="text-chop">kill-switch {killSwitchPct}%</span>
          <span className="text-risk">DQ {dqPct}%</span>
        </div>
      </div>
    </div>
  );
}

// ── Learning: per-regime confidence weights (skill vs luck) ──────────────────
function Learning({ snap }: { snap: Snapshot }) {
  const rows: Regime[] = ["trending", "chopping", "risk_off"];
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r) => {
        const w = snap.learning[r];
        const pct = ((w - 0.5) / 1.0) * 100; // 0.5..1.5 → 0..100
        return (
          <div key={r}>
            <div className="mb-1 flex items-baseline justify-between">
              <RegimeBadge r={r} />
              <span className="tnum font-mono text-xs text-bone">×{w.toFixed(2)}</span>
            </div>
            <div className="relative h-1.5 w-full bg-hair/60">
              {/* 1.00 baseline */}
              <span className="absolute top-[-2px] h-[10px] w-px bg-fog/40" style={{ left: "50%" }} />
              <motion.div
                className="absolute top-0 h-full"
                style={{ background: REGIME[r].color }}
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                transition={{ delay: 0.6, duration: 0.7 }}
              />
            </div>
          </div>
        );
      })}
      <p className="font-mono text-[10px] leading-relaxed text-fog/70">
        graded skill-vs-luck each trade · weight scales next conviction · bounded [0.5–1.5]
      </p>
    </div>
  );
}

// ── Signals readout ──────────────────────────────────────────────────────────
function Signals({ snap }: { snap: Snapshot }) {
  const c = snap.signals.cmc;
  const ch = snap.signals.chain;
  const cell = (label: string, value: ReactNode, color?: string) => (
    <div className="flex items-center justify-between border-b border-hair/60 py-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wide text-fog">{label}</span>
      <span className="tnum font-mono text-xs" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-0 sm:grid-cols-2">
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-signal/70">CMC · agent hub</div>
        {cell("price", n(c.priceUsd, 4, "$"))}
        {cell("fear & greed", n(c.fearGreed), c.fearGreed != null && c.fearGreed <= 25 ? "#E8635D" : undefined)}
        {cell("funding", n(c.fundingRate, 4), c.fundingRate == null ? undefined : c.fundingRate < 0 ? "#E8635D" : "#5DD39E")}
        {cell("RSI · MACD", `${n(c.rsi)} · ${n(c.macd, 3)}`)}
        {cell("market RSI", n(c.marketRsi, 1), c.marketRsi != null && c.marketRsi <= 30 ? "#E8635D" : undefined)}
      </div>
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-signal/70">on-chain · RPC</div>
        {cell("DEX liquidity", usd(ch.liquidityUsd), ch.liquidityUsd == null ? undefined : ch.liquidityUsd < 50000 ? "#E8635D" : "#5DD39E")}
        {cell("buy/sell flow", n(ch.dexImbalance, 2), ch.dexImbalance == null ? undefined : ch.dexImbalance < 0 ? "#E8635D" : "#5DD39E")}
        {cell("net wallet flow", usd(ch.walletFlow))}
        {cell("honeypot", ch.isHoneypot == null ? DASH : ch.isHoneypot ? "FLAGGED" : "clear", ch.isHoneypot ? "#E8635D" : "#5DD39E")}
        <div className="pt-2">
          <div className="font-mono text-[9px] uppercase tracking-wide text-fog/60">macro watch</div>
          {(c.macroEvents ?? []).slice(0, 2).map((m) => (
            <div key={m} className="truncate font-mono text-[10px] text-chop/90">
              ⚑ {m}
            </div>
          ))}
        </div>
      </div>
      {c.narratives && c.narratives.length > 0 && (
        <div className="col-span-full mt-2 flex flex-wrap gap-1.5 border-t border-hair/60 pt-2">
          <span className="font-mono text-[9px] uppercase tracking-wide text-fog/60">trending narratives ·</span>
          {c.narratives.slice(0, 5).map((n) => (
            <span key={n} className="font-mono text-[10px] text-fog">
              {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Guardrails / constitution ────────────────────────────────────────────────
function Guardrails({ snap }: { snap: Snapshot }) {
  const g = snap.guardrails;
  const item = (label: string, value: string) => (
    <div className="flex items-center justify-between py-1">
      <span className="font-mono text-[10px] uppercase tracking-wide text-fog">{label}</span>
      <span className="tnum font-mono text-xs text-bone">{value}</span>
    </div>
  );
  return (
    <div>
      {item("token allowlist", `${g.allowlist}`)}
      {item("per-trade cap", `${g.perTradePct}%`)}
      {item("daily cap", `${g.dailyPct}%`)}
      {item("slippage cap", `${g.slippageBps} bps`)}
      {item("liquidity floor", fmtUsd(g.liquidityFloorUsd))}
      {item("honeypot gate", g.honeypotGate ? "ON" : "off")}
      {item("kill-switch", `${g.killSwitchPct}% (DQ ${g.dqPct}%)`)}
      <div className="mt-3 border-t border-hair pt-3">
        <div className="font-mono text-[10px] uppercase tracking-widest text-signal/70">constitution · ERC-8004</div>
        <div className="mt-1 break-all font-mono text-[10px] text-fog">{snap.agent.constitutionHash}</div>
        <div className="mt-1 font-mono text-[9px] text-fog/60">
          committed on-chain · verifiable · agentId #{snap.agent.agentId}
        </div>
      </div>
    </div>
  );
}

// ── Backtest evidence ────────────────────────────────────────────────────────
function Backtest({ snap }: { snap: Snapshot }) {
  const b = snap.backtest;
  const bar = (label: string, pct: number, color: string) => {
    const mag = Math.min(100, Math.abs(pct));
    return (
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wide text-fog">{label}</span>
          <span className="tnum font-mono text-sm" style={{ color }}>
            {pct >= 0 ? "+" : ""}
            {pct.toFixed(1)}%
          </span>
        </div>
        <div className="h-2 w-full bg-hair/60">
          <motion.div
            className="h-full"
            style={{ background: color }}
            initial={{ width: 0 }}
            animate={{ width: `${mag}%` }}
            transition={{ delay: 0.7, duration: 0.8 }}
          />
        </div>
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="font-mono text-[10px] text-fog/70">
        {b.candles} real daily candles · {b.asset}/USDT · {b.trades} round-trips · {b.winRatePct}% win
      </div>
      {bar(`buy & hold ${b.asset}`, b.buyHoldPct, "#E8635D")}
      {bar("PLIMSOLL (net)", b.strategyPct, "#B8FF3C")}
      <div className="font-mono text-[10px] leading-relaxed text-fog/70">
        net of a measured ~1.4% TWAK round-trip cost (gross {b.grossPct >= 0 ? "+" : ""}
        {b.grossPct.toFixed(1)}%). max drawdown {b.maxDdPct}% — survived a{" "}
        {Math.abs(b.buyHoldPct).toFixed(0)}% market drop in just {b.trades} round-trips.{" "}
        <span className="text-signal">Low-churn by design.</span>
      </div>
    </div>
  );
}

// ── Ledger feed ────────────────────────────────────────────────────────────
function Ledger({ snap }: { snap: Snapshot }) {
  return (
    <div className="flex flex-col">
      {snap.ledger.map((e, i) => {
        const veto = !e.approved && /veto/i.test(e.note);
        const tone = e.approved ? "#5DD39E" : veto ? "#E8635D" : "#8A968F";
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.5 + i * 0.05 }}
            className="grid grid-cols-[58px_56px_1fr_auto] items-center gap-3 border-b border-hair/50 py-2 font-mono text-[11px]"
          >
            <span className="text-fog/60">{e.ts}</span>
            <span className="text-bone">{e.asset}</span>
            <span className="truncate text-fog">{e.note}</span>
            <span className="uppercase tracking-widest" style={{ color: tone }}>
              {e.approved ? `▸ ${e.direction}` : veto ? "✕ veto" : "— hold"}
            </span>
          </motion.div>
        );
      })}
    </div>
  );
}

// ── Top status bar ───────────────────────────────────────────────────────────
function StatusBar({ snap, live }: { snap: Snapshot; live: boolean }) {
  return (
    <motion.header
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-hair bg-ink/80 px-5 py-3 backdrop-blur-md"
    >
      <div className="flex items-center gap-3">
        <span className="font-display text-xl font-bold tracking-[0.2em] text-bone">PLIMSOLL</span>
        <span className="hidden font-mono text-[10px] uppercase tracking-widest text-fog sm:inline">
          autonomous BNB-chain trader
        </span>
      </div>
      <div className="flex items-center gap-4 font-mono text-[11px]">
        <span className="flex items-center gap-1.5" style={{ color: snap.agent.mode === "live" ? "#B8FF3C" : "#E8B84B" }}>
          <span
            className="inline-block h-2 w-2 rounded-full animate-pulse2"
            style={{ background: snap.agent.mode === "live" ? "#B8FF3C" : "#E8B84B" }}
          />
          {snap.agent.mode === "live" ? "LIVE" : "DEV"}
          {!live && <span className="text-fog/50"> · demo data</span>}
        </span>
        <span className="hidden text-fog md:inline">wallet {short(snap.agent.wallet)}</span>
        <span className="hidden text-fog lg:inline">ERC-8004 #{snap.agent.agentId}</span>
        <span className="text-signal">{snap.agent.registered ? "✓ registered" : "unregistered"}</span>
      </div>
    </motion.header>
  );
}

export function Console({ snap, live }: { snap: Snapshot; live: boolean }) {
  const d = snap.latestDecision;
  return (
    <div className="min-h-screen">
      <StatusBar snap={snap} live={live} />

      <main className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6">
        {/* hero line */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.15, duration: 0.6 }}
          className="mb-5 max-w-3xl font-sans text-sm leading-relaxed text-fog"
        >
          The AI <span className="text-bone">proposes</span> · a deterministic kernel{" "}
          <span className="text-signal">decides</span> · Trust Wallet <span className="text-bone">signs</span> · the
          agent <span className="text-bone">learns</span>. The model&apos;s worst idea still can&apos;t breach a limit.
        </motion.p>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* LEFT — pipeline */}
          <div className="lg:col-span-3">
            <Panel title="decision cycle" tag="live" delay={0.1} className="h-full">
              <Pipeline snap={snap} />
            </Panel>
          </div>

          {/* CENTER — latest decision + equity */}
          <div className="flex flex-col gap-4 lg:col-span-5">
            <Panel title="latest decision" tag={d.asset} delay={0.16}>
              <div className="mb-3 flex items-center justify-between">
                <RegimeBadge r={d.regime} size="lg" />
                <span
                  className="font-display text-sm font-semibold uppercase tracking-widest"
                  style={{ color: d.approved ? "#5DD39E" : "#8A968F" }}
                >
                  {d.approved ? `${d.direction} ${fmtUsd(d.sizeUsd)}` : `HOLD`}
                </span>
              </div>
              <Conviction value={d.conviction} regime={d.regime} />
              <p className="mt-3 border-l-2 border-signal/40 pl-3 font-sans text-[13px] leading-relaxed text-bone/90">
                {d.thesis}
              </p>
              <div className="mt-2 font-mono text-[10px] uppercase tracking-wide text-fog/70">
                kernel: {d.kernelReason}
              </div>
            </Panel>
            <Panel title="equity · risk" delay={0.22}>
              <Equity snap={snap} />
            </Panel>
          </div>

          {/* RIGHT — signals */}
          <div className="lg:col-span-4">
            <Panel title="live signals" tag="8 CMC + chain" delay={0.2} className="h-full">
              <Signals snap={snap} />
            </Panel>
          </div>

          {/* ROW 2 — learning / guardrails / backtest */}
          <div className="lg:col-span-3">
            <Panel title="learning" tag="skill vs luck" delay={0.26} className="h-full">
              <Learning snap={snap} />
            </Panel>
          </div>
          <div className="lg:col-span-5">
            <Panel title="risk constitution" tag="enforced pre-sign" delay={0.3} className="h-full">
              <Guardrails snap={snap} />
            </Panel>
          </div>
          <div className="lg:col-span-4">
            <Panel title="backtest" tag="real candles" delay={0.34} className="h-full">
              <Backtest snap={snap} />
            </Panel>
          </div>

          {/* ROW 3 — ledger */}
          <div className="lg:col-span-12">
            <Panel title="decision ledger" tag="auditable trace" delay={0.4}>
              <Ledger snap={snap} />
            </Panel>
          </div>
        </div>

      </main>

      {/* On-chain proof footer. Deliberately a sibling of <main>, not a child:
          a <footer> scoped inside <main> is not exposed as a `contentinfo`
          landmark, so screen-reader users lose the on-chain proof section. */}
      <motion.footer
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5, duration: 0.6 }}
        className="mx-auto mt-4 flex max-w-[1400px] flex-wrap items-center gap-x-5 gap-y-2 border-t border-hair px-5 pb-6 pt-4 font-mono text-[10px] text-fog sm:px-7"
      >
          <span className="uppercase tracking-widest text-signal/70">on-chain proof ·</span>
          <a className="hover:text-signal" href={tx(snap.proof.swapTx)} target="_blank" rel="noreferrer">
            self-custodial swap ↗
          </a>
          <a className="hover:text-signal" href={tx(snap.proof.registerTx)} target="_blank" rel="noreferrer">
            ERC-8004 register ↗
          </a>
          <a className="hover:text-signal" href={tx(snap.proof.setMetadataTx)} target="_blank" rel="noreferrer">
            constitution commit ↗
          </a>
          <a className="hover:text-signal" href={tx(snap.proof.competeTx)} target="_blank" rel="noreferrer">
            competition register ↗
          </a>
        <span className="ml-auto text-fog/50">registry {short(snap.agent.registry)} · BSC mainnet</span>
      </motion.footer>
    </div>
  );
}
