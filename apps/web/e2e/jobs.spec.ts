import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";

const db = createDb();

/** A job that used up its retries, as pg-boss leaves it. */
async function failedJob(message: string): Promise<string> {
  const [row] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO pgboss.job (name, data, state, retry_limit, retry_count, output, completed_on)
     VALUES ('storage.delete', '{"keys":["a"]}'::jsonb, 'failed', 5, 5, $1::jsonb, now()) RETURNING id`,
    JSON.stringify({ message }),
  );
  if (!row) throw new Error("insert failed");
  return row.id;
}

const stateOf = async (id: string) =>
  (
    await db.$queryRawUnsafe<{ state: string }[]>(
      "SELECT state FROM pgboss.job WHERE id = $1::uuid",
      id,
    )
  )[0]?.state;

test("a Picker has no Failed jobs link and is refused at /jobs and the API", async ({ page }) => {
  await signInAs(page, ["PICKER"]);
  await page.goto("/boxes");
  await openNav(page);
  await expect(page.getByRole("link", { name: /Failed jobs/ })).toHaveCount(0);

  await page.goto("/jobs");
  await expect(page.getByText("You don't have permission to do that.")).toBeVisible();
  expect((await page.request.get("/api/v1/ops/jobs/failed")).status()).toBe(403);
});

test("an admin retries a failed job from /jobs", async ({ page }) => {
  const message = `storage down ${crypto.randomUUID()}`;
  const id = await failedJob(message);
  await signInAs(page, ["ADMIN"]);
  await page.goto("/boxes");
  await openNav(page);
  await expect(page.getByTestId("failed-jobs-count")).toBeVisible();

  await page.getByRole("link", { name: /Failed jobs/ }).click();
  const row = page.getByRole("row").filter({ hasText: message });
  await expect(row).toContainText("storage.delete");
  await row.getByRole("button", { name: /^Retry/ }).click();

  await expect(page.getByText("Job queued to run again.")).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(await stateOf(id)).toBe("retry");
});
