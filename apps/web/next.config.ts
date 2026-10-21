import path from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// One .env at the repo root serves every app in development. In production, env comes from the container.
loadEnv({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const config: NextConfig = {
  output: "standalone",
  // Trace from the repo root so the standalone build includes workspace packages.
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  transpilePackages: [
    "@woolrus/contracts",
    "@woolrus/core",
    "@woolrus/db",
    "@woolrus/i18n",
    "@woolrus/logger",
  ],
  serverExternalPackages: ["pino", "pg", "@prisma/adapter-pg", "sharp"],
  typedRoutes: true,
  // CLAUDE.md is the agent entry point; stop `next dev` from generating apps/web/AGENTS.md.
  agentRules: false,
};

export default withNextIntl(config);
