import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

test.afterAll(deleteCreatedOrders);

test("QA writes a customer-visible note, sees the Customer badge, and edits it", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the desktop journey");
  const order = await createOrder({ status: "QA" });
  await signInAs(page, ["QA"]);
  await page.goto(`/orders/${order.id}`);
  // A second tab on the same order: it should pick the note up from the event stream.
  const other = await context.newPage();
  await other.goto(`/orders/${order.id}`);
  await expect(other.getByText("No notes on this order yet.")).toBeVisible();

  const notes = page.getByRole("region", { name: "Notes" });
  await notes.getByRole("textbox", { name: "New note" }).fill("Your order ships in two boxes.");
  // React Aria's switch input is visually hidden, so it can't be clicked directly.
  await notes.getByRole("switch", { name: "Visible to the customer" }).focus();
  await page.keyboard.press("Space");
  await notes.getByRole("button", { name: "Add note" }).click();

  const note = notes.getByTestId("note");
  await expect(note).toContainText("Your order ships in two boxes.");
  await expect(note.getByText("Customer", { exact: true })).toBeVisible();
  await expect(other.getByTestId("note")).toContainText("Your order ships in two boxes.");

  await note.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit note" });
  await dialog.getByRole("textbox", { name: "Note" }).fill("Your order ships in three boxes.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(note).toContainText("Your order ships in three boxes.");
  await expect(note).toContainText("edited");
  await expect(note.getByText("Customer", { exact: true })).toBeVisible();
});

test("a picker writes internal notes only and can't edit someone else's", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the desktop journey");
  const order = await createOrder({ status: "PICKING" });
  await signInAs(page, ["PICKER"]);
  await page.goto(`/orders/${order.id}`);
  const notes = page.getByRole("region", { name: "Notes" });
  await expect(notes.getByRole("textbox", { name: "New note" })).toBeVisible();
  await expect(notes.getByRole("switch", { name: "Visible to the customer" })).toHaveCount(0);
  await notes.getByRole("textbox", { name: "New note" }).fill("Jar lid cracked");
  await notes.getByRole("button", { name: "Add note" }).click();
  await expect(notes.getByTestId("note")).toContainText("Jar lid cracked");
  await expect(notes.getByTestId("note").getByRole("button", { name: "Edit" })).toBeVisible();

  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await signInAs(otherPage, ["PICKER"]);
  await otherPage.goto(`/orders/${order.id}`);
  const theirs = otherPage.getByTestId("note");
  await expect(theirs).toContainText("Jar lid cracked");
  await expect(theirs.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(theirs.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await otherContext.close();
});

test("a note sent to WooCommerce is frozen, even for an admin", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the desktop journey");
  const order = await createOrder({ status: "READY" });
  await signInAs(page, ["ADMIN"]);
  await page.goto(`/orders/${order.id}`);
  const notes = page.getByRole("region", { name: "Notes" });
  await notes.getByRole("textbox", { name: "New note" }).fill("Left at the front desk");
  await notes.getByRole("button", { name: "Add note" }).click();
  const note = notes.getByTestId("note");
  await expect(note.getByRole("button", { name: "Edit" })).toBeVisible();

  // What `shipping` does after posting it.
  const db = createDb();
  await db.note.updateMany({
    where: { orderId: order.id },
    data: { wooNoteId: 4242, pushedToWooAt: new Date() },
  });
  await db.$disconnect();

  await page.reload();
  await expect(note.getByText("Sent to WooCommerce", { exact: true })).toBeVisible();
  await expect(note).toContainText("can't be edited or deleted");
  await expect(note.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(note.getByRole("button", { name: "Delete" })).toHaveCount(0);
});

test("notes need a signed-in caller", async ({ request }) => {
  const order = await createOrder();
  expect((await request.get(`/api/v1/orders/${order.id}/notes`)).status()).toBe(401);
});

test("a picker notes a line from its row, sees the indicators, and deleting clears them", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "tablet", "the floor journey");
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ status: "PICKING", customerName });
  await signInAs(page, ["PICKER"]);
  await page.goto(`/orders/${order.id}`);

  const line = page.getByRole("table", { name: "Items" }).getByRole("row", { name: /E2E item/ });
  await line.getByRole("button", { name: "Add a note on Line: E2E item ×2" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a note on Line: E2E item ×2" });
  // Opened from the line, the picker is preset to it.
  await expect(dialog.getByRole("combobox", { name: "On" })).toHaveValue(/^item:/);
  await dialog.getByRole("textbox", { name: "New note" }).fill("Jar lid cracked");
  await dialog.getByRole("button", { name: "Add note" }).click();
  await expect(dialog).toBeHidden();

  await expect(line.getByRole("img", { name: "1 note" })).toBeVisible();
  const notes = page.getByRole("region", { name: "Notes" });
  const group = notes.getByRole("region", { name: "Line: E2E item ×2" });
  await expect(group.getByTestId("note")).toContainText("Jar lid cracked");
  await notes.getByRole("radio", { name: "Order" }).click();
  await expect(notes.getByText("No notes here.")).toBeVisible();
  await notes.getByRole("radio", { name: "Lines" }).click();
  await expect(group).toBeVisible();

  await page.goto("/queue/picking");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  const row = page.getByRole("row", { name: new RegExp(customerName) });
  await expect(row.getByRole("img", { name: "1 note" })).toBeVisible();

  await page.goto(`/orders/${order.id}`);
  await group.getByRole("button", { name: "Delete" }).click();
  await page
    .getByRole("dialog", { name: "Delete this note?" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(notes.getByText("No notes on this order yet.")).toBeVisible();
  await expect(line.getByRole("img", { name: /note/ })).toHaveCount(0);
});

test("a note's target must be on its order", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "an API check");
  const order = await createOrder();
  const other = await createOrder();
  await signInAs(page, ["PICKER"]);
  const otherLine = (await (await page.request.get(`/api/v1/orders/${other.id}`)).json()).lines[0]
    .id as string;
  const response = await page.request.post(`/api/v1/orders/${order.id}/notes`, {
    data: {
      idempotencyKey: crypto.randomUUID(),
      content: "Wrong line",
      target: { kind: "item", id: otherLine },
    },
  });
  expect(response.status()).toBe(400);
});

// Two small PNGs (32×24, red and blue): real images, so the server's checks and resize run.
const PHOTOS = [
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMElEQVRIiWM4Y2xMU8QwaoHxaBAZj6aiM6MZzXi0qDgzWpoaj1Y4Z0arTOPB3aoAANDIli6iRyQsAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMElEQVRIiWMwNj5DU8QwaoHxaBCdGU1FxqMZ7cxoUWE8Wpoaj1Y4xqNVpvHgblUAADqbli6Hc0YLAAAAAElFTkSuQmCC",
].map((base64, i) => ({
  name: `photo-${i + 1}.png`,
  mimeType: "image/png",
  buffer: Buffer.from(base64, "base64"),
}));

async function choosePhotos(page: Page, scope: ReturnType<Page["getByRole"]>, files = PHOTOS) {
  const chooser = page.waitForEvent("filechooser");
  await scope.getByRole("button", { name: "Choose photos" }).click();
  await (await chooser).setFiles(files);
}

const loaded = (img: ReturnType<Page["locator"]>) =>
  expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0));

test("a picker attaches photos on a tablet, opens them in the lightbox and removes one", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "tablet", "the floor journey");
  const order = await createOrder({ status: "PICKING" });
  await signInAs(page, ["PICKER"]);
  await page.goto(`/orders/${order.id}`);
  const notes = page.getByRole("region", { name: "Notes" });

  // The camera button asks for the rear camera.
  await expect(notes.locator('input[type="file"][capture="environment"]')).toHaveCount(1);
  // A wrong file is refused before upload.
  await choosePhotos(page, notes, [
    { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") },
  ]);
  await expect(page.getByText("Photos must be JPEG, PNG or WebP.", { exact: false })).toBeVisible();

  await choosePhotos(page, notes);
  await expect(notes.getByRole("list", { name: "Photos to add" }).getByRole("img")).toHaveCount(2);
  await notes.getByRole("button", { name: "Add note" }).click();

  const note = notes.getByTestId("note");
  const thumbs = note.getByRole("list", { name: "Photos" }).getByRole("button");
  await expect(thumbs).toHaveCount(2);
  await loaded(thumbs.first().locator("img"));

  await thumbs.first().click();
  const lightbox = page.getByRole("dialog", { name: "Photo 1 of 2" });
  await expect(lightbox).toBeVisible();
  await loaded(lightbox.getByRole("img"));
  await lightbox.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "Photo 2 of 2" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Served through the app, auth-checked per request.
  const src = await thumbs.first().locator("img").getAttribute("src");
  const url = (src ?? "").replace(/\/thumb$/, "");
  const response = await page.request.get(url);
  expect(response.status()).toBe(200);
  expect(response.headers()).toMatchObject({
    "content-type": "image/webp",
    "cache-control": "private, max-age=3600, immutable",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
  });
  expect((await page.request.get(`${url}/thumb`)).status()).toBe(200);
  expect((await request.get(url)).status()).toBe(401);
  expect(
    (await page.request.get("/api/attachments/0199e6a0-0000-7000-8000-00000000dead")).status(),
  ).toBe(404);

  await note.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit note" });
  await dialog.getByRole("button", { name: "Remove photo photo-1.png" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(thumbs).toHaveCount(1);
});

test("attachments need order.read", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "an API check");
  const order = await createOrder({ status: "PICKING" });
  await signInAs(page, ["PICKER"]);
  await page.goto(`/orders/${order.id}`);
  const notes = page.getByRole("region", { name: "Notes" });
  await choosePhotos(page, notes, PHOTOS.slice(0, 1));
  await notes.getByRole("button", { name: "Add note" }).click();
  const img = notes.getByTestId("note").getByRole("list", { name: "Photos" }).locator("img");
  const url = (await img.getAttribute("src")) ?? "";

  const noRoles = await browser.newContext();
  const otherPage = await noRoles.newPage();
  await signInAs(otherPage, []);
  expect((await otherPage.request.get(url)).status()).toBe(403);
  await noRoles.close();
});
