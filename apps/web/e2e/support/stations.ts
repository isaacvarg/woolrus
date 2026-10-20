import { expect, type Page } from "@playwright/test";

/** Opens the nav drawer where it's a drawer (tablet), and leaves it open if it already is. */
export async function openNav(page: Page) {
  const menu = page.getByLabel("Open menu");
  if ((await menu.isVisible()) && !(await page.locator("#nav").isChecked())) await menu.click();
}

/**
 * Taps a name on the station lock screen, once it's hydrated: a tap before that is lost, and the
 * badge input takes focus only then.
 */
export async function chooseTile(page: Page, name: string) {
  await expect(page.getByLabel("Badge")).toBeFocused();
  await page.getByRole("button", { name }).click();
}
