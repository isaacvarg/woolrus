import { execSync } from "node:child_process";
import path from "node:path";
import { config } from "dotenv";
import { PgBoss } from "pg-boss";
import { JOBS_SCHEMA, queues } from "../src/jobs";

/** Points tests at TEST_DATABASE_URL and brings its schema, and pg-boss's, up to date. */
export default async function setup() {
  config({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  process.env.DATABASE_URL = url;
  execSync("pnpm prisma migrate deploy", {
    cwd: path.resolve(import.meta.dirname, "../../db"),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  // `enqueue` needs pg-boss's tables and queues, which the worker creates in real deployments.
  const boss = new PgBoss({
    connectionString: url,
    schema: JOBS_SCHEMA,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  for (const name of Object.values(queues)) await boss.createQueue(name);
  await boss.stop({ graceful: false });
}
