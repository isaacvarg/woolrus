import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// e2e helpers seed users straight into the database, so they need DATABASE_URL from the root .env
// (CI sets it in the environment instead).
loadEnv({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

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
