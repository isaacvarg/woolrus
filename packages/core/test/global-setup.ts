import { execSync } from "node:child_process";
import path from "node:path";
import { config } from "dotenv";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { installJobs } from "../src/install-jobs";
import { TEST_WORKERS } from "./workers";

declare module "vitest" {
  interface ProvidedContext {
    /** One database per worker, indexed by `VITEST_POOL_ID - 1`. */
    workerDatabaseUrls: string[];
  }
}

/**
 * Brings TEST_DATABASE_URL's schema, and pg-boss's, up to date, then clones it into one database
 * per worker (`<name>_w1`, `<name>_w2`, …) so test files can run in parallel without sharing
 * rows, LISTEN channels or locks. `worker-db.ts` points each worker at its copy.
 */
export default async function setup(project: TestProject) {
  config({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  execSync("pnpm prisma migrate deploy", {
    cwd: path.resolve(import.meta.dirname, "../../db"),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  // `enqueue` needs pg-boss's tables and queues, which the worker creates in real deployments.
  await installJobs(url);

  const template = new URL(url).pathname.slice(1);
  const names = Array.from({ length: TEST_WORKERS }, (_, i) => `${template}_w${i + 1}`);
  await withAdmin(url, async (admin) => {
    for (const name of names) {
      await admin.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
      await createFromTemplate(admin, name, template);
      // Throwaway data: commits needn't wait for the disk (not copied from the template).
      await admin.query(`ALTER DATABASE ${ident(name)} SET synchronous_commit = off`);
    }
  });
  project.provide(
    "workerDatabaseUrls",
    names.map((name) => withDatabase(url, name)),
  );

  return async () => {
    await withAdmin(url, async (admin) => {
      for (const name of names)
        await admin.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
    });
  };
}

/** Runs `fn` with a client on the server's `postgres` database, which is never a template. */
async function withAdmin(url: string, fn: (admin: pg.Client) => Promise<void>): Promise<void> {
  const admin = new pg.Client({ connectionString: withDatabase(url, "postgres") });
  await admin.connect();
  try {
    await fn(admin);
  } finally {
    await admin.end();
  }
}

/** The template's last sessions (migrate, pg-boss) can take a moment to leave after they close. */
async function createFromTemplate(admin: pg.Client, name: string, template: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await admin.query(`CREATE DATABASE ${ident(name)} TEMPLATE ${ident(template)}`);
      return;
    } catch (error) {
      const busy = (error as { code?: string }).code === "55006"; // object_in_use
      if (!busy || attempt === 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function withDatabase(url: string, name: string): string {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}

function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
