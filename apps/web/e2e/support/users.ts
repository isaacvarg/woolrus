import { expect, type Page } from "@playwright/test";

/**
 * The /users row for a name or email. The list is paged, and a local database holds thousands of
 * e2e users, so search for it rather than hoping it's on the first page. Typing before hydration
 * is lost, so it types again until the row shows.
 */
export async function findUserRow(page: Page, text: string) {
  const box = page.getByRole("searchbox", { name: "Search users" });
  const row = page.getByRole("row").filter({ hasText: text });
  await expect(async () => {
    await box.fill(text);
    await expect(row).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  return row;
}
