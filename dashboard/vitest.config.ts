import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Dashboard unit tests. jsdom because the console is a React tree; the e2e suite
// (playwright.config.ts) covers what a real browser does with it.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror the "@/*" path alias from tsconfig so tests import exactly what the
    // app imports — otherwise a broken alias passes here and fails in `next build`.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    // e2e/ is Playwright's — it must not be collected by vitest.
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
