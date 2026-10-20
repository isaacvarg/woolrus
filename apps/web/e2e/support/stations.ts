import { expect, type Page } from "@playwright/test";

/**
 * Taps a name on the station lock screen, once it's hydrated: a tap before that is lost, and the
 * badge input takes focus only then.
 */
export async function chooseTile(page: Page, name: string) {
  await expect(page.getByLabel("Badge")).toBeFocused();
  await page.getByRole("button", { name }).click();
}
