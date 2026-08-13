import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Console } from "@/components/Console";
import { DASH } from "@/lib/format";
import { makeSnapshot, scenarios } from "./fixtures";

// Component-level checks on what the console ASSERTS about the agent. The
// dashboard is the artefact people judge the agent by, so the states that must
// never be misreported are: whether a trade was approved, whether the kernel
// vetoed, and whether a missing signal is honestly shown as missing.

/** Scope a query to one panel by its header. Several labels legitimately repeat
 *  across panels ("TRENDING" is both the current regime and a learning row), so
 *  an unscoped query would be ambiguous — and would pass for the wrong reason. */
function panel(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title });
  const section = heading.closest("section");
  if (!section) throw new Error(`no panel found for "${title}"`);
  return section as HTMLElement;
}

describe("Console — status bar", () => {
  it("shows LIVE for a live-mode agent on live data", () => {
    render(<Console snap={scenarios.approved()} live />);
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.queryByText(/demo data/)).not.toBeInTheDocument();
  });

  it("marks demo data when the snapshot is the bundled sample", () => {
    render(<Console snap={scenarios.approved()} live={false} />);
    expect(screen.getByText(/demo data/)).toBeInTheDocument();
  });

  it("shows DEV and 'unregistered' for a dev agent with no on-chain identity", () => {
    render(<Console snap={scenarios.devUnregistered()} live />);
    expect(screen.getByText("DEV")).toBeInTheDocument();
    expect(screen.getByText("unregistered")).toBeInTheDocument();
  });

  it("truncates the wallet rather than printing it in full", () => {
    render(<Console snap={scenarios.approved()} live />);
    expect(screen.getByText(/wallet 0xB848…a1e5/)).toBeInTheDocument();
  });
});

describe("Console — latest decision", () => {
  it("renders an approved buy with its direction and size", () => {
    render(<Console snap={scenarios.approved()} live />);
    const decision = panel("latest decision");
    expect(within(decision).getByText("buy $108.00")).toBeInTheDocument();
    expect(within(decision).getByText("TRENDING")).toBeInTheDocument();
    expect(within(decision).getByText("72%")).toBeInTheDocument();
  });

  it("renders HOLD and the kernel's reason when the decision was NOT approved", () => {
    render(<Console snap={scenarios.veto()} live />);
    expect(screen.getByText("HOLD")).toBeInTheDocument();
    expect(screen.queryByText(/^buy \$/)).not.toBeInTheDocument();
    expect(screen.getByText(/risk-off — sleeve flat/)).toBeInTheDocument();
  });

  it("always shows the falsifiable thesis", () => {
    render(<Console snap={scenarios.approved()} live />);
    expect(screen.getByText(/invalidated if RSI closes below 45/)).toBeInTheDocument();
  });

  it("clamps conviction display at the ends of the range", () => {
    render(<Console snap={makeSnapshot({ latestDecision: { conviction: 1 } })} live />);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });
});

describe("Console — pipeline", () => {
  it("marks the kernel approved when the trade passed", () => {
    render(<Console snap={scenarios.approved()} live />);
    expect(screen.getByText("▸ approved")).toBeInTheDocument();
    expect(screen.queryByText("▪ held / veto")).not.toBeInTheDocument();
  });

  it("marks the kernel as a veto when it refused", () => {
    render(<Console snap={scenarios.veto()} live />);
    expect(screen.getByText("▪ held / veto")).toBeInTheDocument();
    expect(screen.queryByText("▸ approved")).not.toBeInTheDocument();
  });

  it("renders every stage of the separation-of-powers pipe", () => {
    render(<Console snap={scenarios.approved()} live />);
    for (const stage of ["STATE", "SIGNALS", "BRAIN", "KERNEL", "EXEC", "LEDGER"]) {
      expect(screen.getByText(stage)).toBeInTheDocument();
    }
  });
});

describe("Console — signals (fail-soft rendering)", () => {
  it("never prints 'undefined' or 'NaN' when every signal is missing", () => {
    const { container } = render(<Console snap={scenarios.blindSignals()} live />);
    expect(container.textContent).not.toMatch(/undefined|NaN/);
  });

  it("renders em-dashes for the missing readings", () => {
    const { container } = render(<Console snap={scenarios.blindSignals()} live />);
    const dashes = (container.textContent ?? "").split(DASH).length - 1;
    // price, F&G, funding, RSI, MACD, market RSI, liquidity, flow, wallet flow, honeypot
    expect(dashes).toBeGreaterThanOrEqual(9);
  });

  it("still renders present signals normally", () => {
    render(<Console snap={scenarios.approved()} live />);
    expect(screen.getByText("$1.2626")).toBeInTheDocument(); // price
    expect(screen.getByText("62")).toBeInTheDocument(); // fear & greed
    expect(screen.getByText("clear")).toBeInTheDocument(); // honeypot
  });

  it("flags a honeypot loudly", () => {
    render(<Console snap={scenarios.distressed()} live />);
    expect(screen.getByText("FLAGGED")).toBeInTheDocument();
  });
});

describe("Console — equity and PnL", () => {
  it("renders the PnL panel with a signed value when the block is present", () => {
    render(<Console snap={scenarios.approved()} live />);
    expect(screen.getByText("+$42.18")).toBeInTheDocument();
    expect(screen.getByText(/\+4\.22%/)).toBeInTheDocument();
  });

  it("renders a negative PnL with a minus sign, not a stray dash", () => {
    render(<Console snap={scenarios.distressed()} live />);
    expect(screen.getByText("−$220.00")).toBeInTheDocument();
  });

  it("omits the PnL panel entirely when the snapshot has no pnl block", () => {
    render(<Console snap={scenarios.noPnl()} live />);
    expect(screen.queryByText("invested")).not.toBeInTheDocument();
    expect(screen.queryByText("PnL")).not.toBeInTheDocument();
  });

  it("shows drawdown against the kill-switch and DQ markers", () => {
    render(<Console snap={scenarios.approved()} live />);
    const equity = panel("equity · risk");
    expect(within(equity).getByText("1.8%")).toBeInTheDocument();
    expect(within(equity).getByText(/kill-switch 20%/)).toBeInTheDocument();
    expect(within(equity).getByText(/DQ 30%/)).toBeInTheDocument();
  });

  it("renders a drawdown past the kill-switch without breaking the bar", () => {
    render(<Console snap={scenarios.distressed()} live />);
    expect(screen.getByText("26.5%")).toBeInTheDocument();
  });
});

describe("Console — guardrails", () => {
  it("renders the committed constitution hash in full for verification", () => {
    render(<Console snap={scenarios.approved()} live />);
    expect(
      screen.getByText("0x7c0af11bda62efaea35892ee53bc6ee926fff1a15b404564183a253b582c152e"),
    ).toBeInTheDocument();
  });

  it("renders each enforced limit", () => {
    render(<Console snap={scenarios.approved()} live />);
    expect(screen.getByText("148")).toBeInTheDocument(); // allowlist size
    expect(screen.getByText("15%")).toBeInTheDocument(); // per-trade cap
    expect(screen.getByText("100 bps")).toBeInTheDocument(); // slippage
    expect(screen.getByText("ON")).toBeInTheDocument(); // honeypot gate
  });
});

describe("Console — ledger", () => {
  it("renders one row per entry with its outcome marker", () => {
    render(<Console snap={scenarios.approved()} live />);
    expect(screen.getByText("▸ buy")).toBeInTheDocument();
    expect(screen.getByText("✕ veto")).toBeInTheDocument();
    expect(screen.getByText("— hold")).toBeInTheDocument();
  });

  it("distinguishes a kernel veto from a plain hold", () => {
    // Both are `approved: false`; only the veto note earns the veto marker.
    render(<Console snap={scenarios.approved()} live />);
    expect(screen.getByText(/DEX liquidity below floor/)).toBeInTheDocument();
    expect(screen.getByText(/no edge, standing down/)).toBeInTheDocument();
  });

  it("renders an empty ledger without crashing", () => {
    render(<Console snap={makeSnapshot({ ledger: [] })} live />);
    expect(screen.getByText("decision ledger")).toBeInTheDocument();
  });
});

describe("Console — on-chain proof", () => {
  it("links every proof tx to BscScan and opens them safely", () => {
    render(<Console snap={scenarios.approved()} live />);
    const swap = screen.getByRole("link", { name: /self-custodial swap/ });
    expect(swap).toHaveAttribute(
      "href",
      "https://bscscan.com/tx/0xf24bc1ca67f50d6eec42c370125d8bcde064b9d96d2121e92038ef8b77539fd1",
    );
    // Untrusted external target — must not get window.opener access.
    expect(swap).toHaveAttribute("rel", "noreferrer");
    expect(swap).toHaveAttribute("target", "_blank");
  });

  it("renders all four proof links", () => {
    render(<Console snap={scenarios.approved()} live />);
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getAllByRole("link")).toHaveLength(4);
  });
});
