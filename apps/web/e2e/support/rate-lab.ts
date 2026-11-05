import { expect, type Locator, type Page } from "@playwright/test";
import { createFakeShippingProvider, runLabRun } from "@woolrus/core";
import type { Db } from "@woolrus/db";

/** The run a row links to (its first link is the run's page), so a spec never guesses by status. */
export async function runIdOf(row: Locator): Promise<string> {
  const href = await row.getByRole("link").first().getAttribute("href");
  const id = href?.match(/^\/rate-lab\/runs\/([0-9a-f-]{36})$/)?.[1];
  if (!id) throw new Error(`no run link in the row: ${href}`);
  return id;
}

/** The run whose page is open. */
export async function runIdOfPage(page: Page, not?: string): Promise<string> {
  await expect(page).toHaveURL(/\/rate-lab\/runs\/[0-9a-f-]{36}$/);
  if (not) await expect(page).not.toHaveURL(`/rate-lab/runs/${not}`);
  const id = new URL(page.url()).pathname.split("/").at(-1);
  if (!id) throw new Error(`no run in ${page.url()}`);
  return id;
}

/**
 * Runs `runId` here (CI starts no worker) on the fake ShipStation, whose quotes all wait until
 * `release()`: while they wait the run is provably mid-flight, whatever the machine's speed.
 * `inFlight(n)` resolves once n quotes are waiting. Locally, root `pnpm dev` also starts the worker,
 * which can claim the job first; `job` and `inFlight` then fail saying so (run the web app alone).
 */
export function gatedLabRun(db: Db, runId: string) {
  const provider = createFakeShippingProvider("SHIPSTATION");
  const getRates = provider.getRates.bind(provider);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = 0;
  const onWait: (() => void)[] = [];
  provider.getRates = async (request) => {
    waiting += 1;
    for (const notify of onWait) notify();
    await gate;
    return getRates(request);
  };

  // The gate may stay shut for a while: well past the provider timeout, so no quote times out.
  const job = runLabRun(db, [provider], { runId }, { timeoutMs: 120_000 }).then((result) => {
    if (result.status === "skipped") {
      throw new Error("Another process (a local worker?) claimed the run before the test did.");
    }
    return result;
  });
  const ended = job.then((result) => {
    throw new Error(`The run ended (${result.status}) before its quotes were in flight.`);
  });
  // Awaited by the test (or not, when it fails early): never an unhandled rejection.
  job.catch(() => {});
  ended.catch(() => {});

  const inFlight = (n: number) =>
    Promise.race([
      new Promise<void>((resolve) => {
        const check = () => {
          if (waiting >= n) resolve();
        };
        onWait.push(check);
        check();
      }),
      ended,
    ]);

  return {
    job,
    inFlight,
    release,
    /** For a `finally`: lets a run the test left mid-flight finish, so nothing writes to it later. */
    async settle() {
      release();
      await job.catch(() => {});
    },
  };
}
