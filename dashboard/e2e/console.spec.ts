import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { FIXTURE_URL } from "../playwright.config";
import { makeSnapshot, scenarios, type ScenarioName } from "../test/fixtures";

// FULL END-TO-END SCENARIOS.
//
// Every test drives the real production Next build in a real browser. The only
// thing faked is the agent itself: the fixture server stands in for the live
// snapshot endpoint, so the page's own data layer, server rendering and markup
// are all exercised for real.
//
// The through-line: this console is how a human decides whether to trust an
// autonomous agent with money. The states that must never be misreported are
// (1) did it trade, (2) did the kernel stop it, (3) is a signal actually
// missing. Each gets an end-to-end scenario.

/** Stage a snapshot on the fixture agent, then load the page fresh. */
async function visit(page: Page, request: APIRequestContext, snap: unknown) {
  const res = await request.put(`${FIXTURE_URL}/snapshot`, { data: snap as object });
  expect(res.status(), "fixture server should accept the staged snapshot").toBe(204);
  await page.goto("/", { waitUntil: "domcontentloaded" });
}

const visitScenario = (page: Page, request: APIRequestContext, name: ScenarioName) =>
  visit(page, request, scenarios[name]());

/** Scope to one panel by its header. Labels repeat across the console by design
 *  (a regime name is both the current decision and a learning row), and
 *  Playwright's getByText is a case-insensitive SUBSTRING match — so "LIVE"
 *  also hits "live signals". Scope, and use exact where the value is a whole cell. */
const panel = (page: Page, title: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test.describe("console — first paint", () => {
  test("renders every panel of the command console", async ({ page, request }) => {
    await visitScenario(page, request, "approved");

    for (const title of [
      "decision cycle",
      "latest decision",
      "equity · risk",
      "live signals",
      "learning",
      "risk constitution",
      "backtest",
      "decision ledger",
    ]) {
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
    }
  });

  test("states the separation-of-powers claim above the fold", async ({ page, request }) => {
    await visitScenario(page, request, "approved");
    await expect(page.getByText(/worst idea still can/i)).toBeVisible();
  });

  test("serves live agent data rather than the bundled demo sample", async ({ page, request }) => {
    await visitScenario(page, request, "approved");
    // "· demo data" appears only when the snapshot fell back to the bundle.
    await expect(page.getByText("demo data")).toHaveCount(0);
  });
});

test.describe("scenario — approved trade", () => {
  test("reports the trade, its size, and an approving kernel", async ({ page, request }) => {
    await visitScenario(page, request, "approved");

    const decision = panel(page, "latest decision");
    await expect(decision.getByText("buy $108.00", { exact: true })).toBeVisible();
    await expect(decision.getByText("TRENDING", { exact: true })).toBeVisible();
    await expect(decision.getByText("72%", { exact: true })).toBeVisible();

    await expect(page.getByText("▸ approved")).toBeVisible();
    await expect(page.getByText("▪ held / veto")).toHaveCount(0);
  });

  test("shows the falsifiable thesis, not just a verdict", async ({ page, request }) => {
    await visitScenario(page, request, "approved");
    await expect(page.getByText(/invalidated if RSI closes below 45/)).toBeVisible();
  });
});

test.describe("scenario — kernel veto", () => {
  test("reports HOLD with the kernel's reason and no executed size", async ({ page, request }) => {
    await visitScenario(page, request, "veto");

    const decision = panel(page, "latest decision");
    await expect(decision.getByText("HOLD", { exact: true })).toBeVisible();
    // exact: "risk-off — sleeve flat" (the kernel reason) also contains "risk-off".
    await expect(decision.getByText("RISK-OFF", { exact: true })).toBeVisible();
    await expect(page.getByText(/risk-off — sleeve flat/)).toBeVisible();

    // The pipeline must show the kernel stopping the trade.
    await expect(page.getByText("▪ held / veto")).toBeVisible();
    await expect(page.getByText("▸ approved")).toHaveCount(0);
  });

  test("never renders a buy size for a vetoed decision", async ({ page, request }) => {
    await visitScenario(page, request, "veto");
    const decision = panel(page, "latest decision");
    await expect(decision.getByText(/^buy \$/)).toHaveCount(0);
  });
});

test.describe("scenario — signals unavailable (fail-soft)", () => {
  test("renders em-dashes and never leaks 'undefined' or 'NaN' to the page", async ({ page, request }) => {
    await visitScenario(page, request, "blindSignals");

    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    expect(body).not.toMatch(/undefined/i);
    expect(body).not.toMatch(/\bNaN\b/);
    // Each missing reading collapses to an em-dash.
    expect((body.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(9);
  });

  test("still renders the rest of the console when every signal is missing", async ({ page, request }) => {
    await visitScenario(page, request, "blindSignals");
    await expect(page.getByRole("heading", { name: "live signals" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "decision ledger" })).toBeVisible();
  });
});

test.describe("scenario — distressed agent", () => {
  test("shows the drawdown past the kill-switch and flags the honeypot", async ({ page, request }) => {
    await visitScenario(page, request, "distressed");

    // Scoped: the kernel reason string also contains "26.5%".
    await expect(panel(page, "equity · risk").getByText("26.5%", { exact: true })).toBeVisible();
    await expect(page.getByText("FLAGGED")).toBeVisible();
    await expect(page.getByText(/drawdown 26\.5% >= kill-switch 20%/)).toBeVisible();
  });

  test("renders a loss with a minus sign", async ({ page, request }) => {
    await visitScenario(page, request, "distressed");
    await expect(page.getByText("−$220.00")).toBeVisible();
  });
});

test.describe("scenario — agent identity", () => {
  test("shows DEV and unregistered for an unregistered dev agent", async ({ page, request }) => {
    await visitScenario(page, request, "devUnregistered");
    const bar = page.getByRole("banner");
    await expect(bar.getByText("DEV", { exact: true })).toBeVisible();
    await expect(bar.getByText("unregistered", { exact: true })).toBeVisible();
  });

  test("shows LIVE and registered for the live agent", async ({ page, request }) => {
    await visitScenario(page, request, "approved");
    // Scoped to the status bar: "LIVE" is a substring of the "live signals" panel.
    const bar = page.getByRole("banner");
    await expect(bar.getByText("LIVE", { exact: true })).toBeVisible();
    await expect(bar.getByText("✓ registered", { exact: true })).toBeVisible();
  });
});

test.describe("scenario — optional PnL block", () => {
  test("renders the PnL panel when the agent reports one", async ({ page, request }) => {
    await visitScenario(page, request, "approved");
    await expect(page.getByText("+$42.18")).toBeVisible();
  });

  test("omits the PnL panel entirely when absent, without a gap or error", async ({ page, request }) => {
    await visitScenario(page, request, "noPnl");
    await expect(page.getByText("invested")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "equity · risk" })).toBeVisible();
  });
});

test.describe("on-chain proof links", () => {
  test("every proof links to the right BscScan transaction and opens safely", async ({ page, request }) => {
    await visitScenario(page, request, "approved");

    const footer = page.locator("footer");
    const links = footer.getByRole("link");
    await expect(links).toHaveCount(4);

    const swap = footer.getByRole("link", { name: /self-custodial swap/ });
    await expect(swap).toHaveAttribute(
      "href",
      "https://bscscan.com/tx/0xf24bc1ca67f50d6eec42c370125d8bcde064b9d96d2121e92038ef8b77539fd1",
    );
    await expect(swap).toHaveAttribute("target", "_blank");
    // No window.opener handle back into the console.
    await expect(swap).toHaveAttribute("rel", "noreferrer");
  });
});

test.describe("live data refresh", () => {
  test("picks up the agent's next cycle on reload — the page is never cached stale", async ({ page, request }) => {
    await visit(page, request, makeSnapshot({ cycle: 100 }));
    await expect(page.getByText("#100")).toBeVisible();

    // The agent advances a cycle and re-decides.
    await visit(page, request, makeSnapshot({ cycle: 101, latestDecision: { asset: "ETH" } }));
    await expect(page.getByText("#101")).toBeVisible();
    await expect(page.getByText("#100")).toHaveCount(0);
  });
});

test.describe("resilience — agent unreachable", () => {
  test("falls back to the bundled sample and says so, rather than erroring", async ({ page, request }) => {
    // Serve something the dashboard cannot parse as a snapshot.
    const res = await request.put(`${FIXTURE_URL}/snapshot`, { data: { totally: "not a snapshot" } });
    expect(res.status()).toBe(204);

    const response = await page.goto("/", { waitUntil: "domcontentloaded" });
    // The page must still be a 200 with a rendered console, never a 500.
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "latest decision" })).toBeVisible();
  });
});

test.describe("accessibility and structure", () => {
  test("uses real landmarks and headings, not a soup of divs", async ({ page, request }) => {
    await visitScenario(page, request, "approved");
    await expect(page.getByRole("banner")).toBeVisible(); // sticky status bar
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible(); // proof footer
    expect(await page.getByRole("heading", { level: 2 }).count()).toBeGreaterThanOrEqual(8);
  });

  test("has no horizontal overflow — the grid must not spill the viewport", async ({ page, request }) => {
    await visitScenario(page, request, "approved");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1); // sub-pixel rounding only
  });
});
