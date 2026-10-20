import type { Page } from "@playwright/test";

/**
 * Opens the nav drawer where it's a drawer (tablet width, or a collapsed sidebar), and leaves it
 * open if it already is: a second click would close it. The button's label follows the page's
 * language.
 */
export async function openNav(page: Page) {
  const menu = page.getByLabel(/^(Open menu|Abrir menú)$/);
  if ((await menu.isVisible()) && !(await page.locator("#nav").isChecked())) await menu.click();
}
