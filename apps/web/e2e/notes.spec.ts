import { expect, test } from "@playwright/test";
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
