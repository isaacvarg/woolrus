import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // The floor runs on Android tablets.
    { name: "tablet", use: { ...devices["Galaxy Tab S9"] } },
  ],
  // Reuse a running dev server locally; CI starts the production build itself.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "pnpm dev", url: `${baseURL}/api/health`, reuseExistingServer: true },
});
