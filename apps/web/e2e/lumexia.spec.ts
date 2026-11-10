import { expect, type Page, test } from "@playwright/test";
import en from "@woolrus/i18n/messages/en.json" with { type: "json" };
import es from "@woolrus/i18n/messages/es.json" with { type: "json" };
import { signInAs } from "./support/auth";

// Lumexia items (SPEC-lumexia "Reads and UI", ticket #162). The dev stack has no Lumexia, so its
// answers are stubbed at the RPC layer; core's tests cover the linking itself against the fake.

const PRODUCT = "0190a000-0000-7000-8000-00000000e001";
const ITEM = "0190a000-0000-7000-8000-00000000e101";
const BASE = "0190a000-0000-7000-8000-0000000000a1";

const unlinked = {
  id: PRODUCT,
  name: "Lavender base 1 gal",
  sku: "BASE1234",
  physical: true,
  link: null,
  lotOverride: null,
  needsLot: false,
};
const linked = {
  ...unlinked,
  link: {
    itemId: ITEM,
    referenceCode: "BASE1234",
    itemTypeId: BASE,
    itemTypeName: "Production base",
    syncedAt: null,
    notFound: false,
  },
  needsLot: true,
};

const rpc = (json: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ json }),
});

/** Stubs the page's Lumexia calls; `linkProducts` flips the product to linked under Production base. */
async function stubLumexia(page: Page) {
  let isLinked = false;
  await page.route(/\/rpc\/lumexia\/products/, (route) =>
    route.fulfill(rpc({ configured: true, products: [isLinked ? linked : unlinked] })),
  );
  await page.route(/\/rpc\/lumexia\/suggestLinks/, (route) =>
    route.fulfill(
      rpc([
        {
          productId: PRODUCT,
          productName: unlinked.name,
          sku: "BASE1234",
          item: {
            id: ITEM,
            referenceCode: "BASE1234",
            name: "Lavender base",
            aliases: [],
            itemTypeId: BASE,
            procurementTypeId: null,
            inventoryTypeId: null,
            archived: false,
          },
          matchedOn: "referenceCode",
          matchedValue: "BASE1234",
        },
      ]),
    ),
  );
  await page.route(/\/rpc\/lumexia\/linkProducts/, (route) => {
    isLinked = true;
    return route.fulfill(rpc({ linked: 1 }));
  });
}

test("an admin matches by SKU, confirms, and sees the product linked with Needs lot: Yes, in en and es", async ({
  page,
}) => {
  await stubLumexia(page);
  await signInAs(page, ["ADMIN"]);
  try {
    await page.request.patch("/api/v1/me/preferences", { data: { locale: "es" } });
    await page.goto("/lumexia");
    await expect(page.getByRole("heading", { name: es.lumexiaItems.title })).toBeVisible();
    await expect(page.getByRole("button", { name: es.lumexiaItems.matchBySku })).toBeVisible();
    // The filter has a "Not linked" option too: look in the table.
    await expect(page.getByRole("cell", { name: es.lumexiaItems.notLinked })).toBeVisible();
  } finally {
    await page.request.patch("/api/v1/me/preferences", { data: { locale: "en" } });
  }

  const t = en.lumexiaItems;
  await page.goto("/lumexia");
  const row = page.getByRole("row", { name: new RegExp(unlinked.name) });
  await expect(row.getByText(t.notLinked)).toBeVisible();

  await page.getByRole("button", { name: t.matchBySku }).click();
  const dialog = page.getByRole("dialog", { name: t.review.title });
  await expect(dialog.getByText("matched reference code BASE1234")).toBeVisible();
  const request = page.waitForRequest(/\/rpc\/lumexia\/linkProducts/);
  await dialog.getByRole("button", { name: "Link 1 product" }).click();
  expect((await request).postDataJSON().json).toEqual({
    links: [{ productId: PRODUCT, itemId: ITEM }],
  });
  await expect(page.getByText("Linked 1 product.")).toBeVisible();
  await expect(dialog).toBeHidden();

  await expect(row.getByText("BASE1234", { exact: true }).first()).toBeVisible();
  await expect(row.getByText("Production base")).toBeVisible();
  await expect(row.getByRole("cell", { name: t.yes, exact: true })).toBeVisible();
  await page.getByRole("radio", { name: t.filters.needsLot }).click();
  await expect(page.getByRole("row", { name: new RegExp(unlinked.name) })).toBeVisible();
});

test("without a Lumexia client the page says it isn't configured and links to Settings", async ({
  page,
}) => {
  await page.route(/\/rpc\/lumexia\/products/, (route) =>
    route.fulfill(rpc({ configured: false, products: [] })),
  );
  await signInAs(page, ["ADMIN"]);
  await page.goto("/lumexia");
  const alert = page.getByRole("alert").filter({ hasText: en.lumexiaItems.notConfigured });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("link", { name: en.lumexiaItems.openSettings })).toHaveAttribute(
    "href",
    "/settings",
  );
});

test("Lumexia items is Admin-only, in the page and the API", async ({ page }) => {
  await signInAs(page, ["PACKER"]);
  await page.goto("/lumexia");
  await expect(page.getByRole("alert").filter({ hasText: en.errors.forbidden })).toBeVisible();
  expect((await page.request.get("/api/v1/lumexia/products")).status()).toBe(403);
  expect((await page.request.post("/api/v1/lumexia/suggest-links")).status()).toBe(403);
});
