import { expect, test } from "@playwright/test";
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
