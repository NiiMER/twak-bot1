import { defineConfig, devices } from "@playwright/test";

// E2E for the console: a real browser against a real production Next build,
// fed by the fixture server standing in for the live agent.

const APP_PORT = Number(process.env.E2E_PORT ?? 3940);
const FIXTURE_PORT = Number(process.env.FIXTURE_PORT ?? 3941);

export const APP_URL = `http://127.0.0.1:${APP_PORT}`;
export const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;

// Sandboxes and CI images sometimes ship a Chromium that doesn't match the
// build this Playwright pins. Setting PLAYWRIGHT_CHROMIUM_PATH points at that
// binary instead of downloading one; unset (the CI default, after
// `playwright install chromium`) Playwright uses its own.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "./e2e",
  // The fixture server holds ONE staged snapshot that tests mutate between
  // navigations, so parallel workers would race each other's scenario. The
  // suite is fast; serial is the correct trade.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: APP_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: executablePath ? { executablePath } : {} } },
    // A real mobile viewport: the console is a dense grid that collapses to one
    // column, and the status bar hides fields by breakpoint — worth asserting.
    { name: "mobile", use: { ...devices["Pixel 5"], launchOptions: executablePath ? { executablePath } : {} } },
  ],

  webServer: [
    {
      command: "node e2e/fixture-server.mjs",
      url: `${FIXTURE_URL}/health`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      env: { FIXTURE_PORT: String(FIXTURE_PORT) },
    },
    {
      // Production build, not `next dev`: it's what actually ships, and it
      // removes dev-only overlays and recompiles from the assertions.
      command: `npm run build && npx next start -p ${APP_PORT}`,
      url: APP_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      env: { PLIMSOLL_SNAPSHOT_URL: `${FIXTURE_URL}/snapshot` },
    },
  ],
});
