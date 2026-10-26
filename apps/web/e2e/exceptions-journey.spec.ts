import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

// SPEC-exceptions criterion 18: the whole exceptions journey, one role after another.

const db = createDb();

test.afterAll(deleteCreatedOrders);

// A small real PNG (32×24), so the server's image checks run.
const PHOTO = {
  name: "dent.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMElEQVRIiWM4Y2xMU8QwaoHxaBAZj6aiM6MZzXi0qDgzWpoaj1Y4Z0arTOPB3aoAANDIli6iRyQsAAAAAElFTkSuQmCC",
    "base64",
  ),
};

const search = "Search by order number or customer";

test("out of stock, void, pack, report, resolve and delete: the exceptions journey", async ({
  page,
}) => {
  const customerName = `E2E journey ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, quantity: 4 });

  // A picker marks the line Out of Stock, voids the missing unit from the banner and finishes.
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Begin Picking" })
    .click();
  await expect(page).toHaveURL(`/pick/${order.id}`);
  const card = page.getByTestId("pick-card").first();
  await card.getByRole("button", { name: "More for E2E item" }).click();
  await page.getByRole("menuitem", { name: "Out of Stock" }).click();
  const oos = page.getByRole("dialog", { name: "E2E item is out of stock" });
  await oos.getByRole("textbox", { name: "How many did you find?" }).fill("3");
  await oos.getByRole("textbox", { name: "Note" }).fill("Three on the shelf");
  await oos.getByRole("button", { name: "Mark Out of Stock" }).click();
  await expect(card.getByTestId("pick-status")).toHaveText(/Out of stock/);
  await page.getByTestId("oos-banner").getByRole("button", { name: "Void E2E item" }).click();
  const voidDialog = page.getByRole("dialog", { name: "Void E2E item" });
  await voidDialog.getByRole("textbox", { name: "How many to void" }).fill("1");
  await voidDialog.getByRole("radio", { name: "Out of stock" }).click();
  await voidDialog.getByRole("button", { name: "Void", exact: true }).click();
  await expect(card.getByTestId("pick-status")).toHaveText(/Picked/);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page).toHaveURL("/queue/pending");
  await expect
    .poll(async () => (await db.order.findUniqueOrThrow({ where: { id: order.id } })).status)
    .toBe("PACKING");

  // A packer boxes both remaining units, voids one, and sees the re-weigh flag.
  const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  const pkg = await db.package.create({
    data: { orderId: order.id, number: 1, lengthIn: 12, widthIn: 9, heightIn: 4, weightOz: 16 },
  });
  await db.packageItem.create({ data: { packageId: pkg.id, orderItemId: item.id, quantity: 2 } });
  await signInAs(page, ["PACKER"]);
  await page.goto(`/pack/${order.id}`);
  await page.getByTestId("pack-item").getByRole("button", { name: "Void" }).click();
  const packVoid = page.getByRole("dialog", { name: "Void E2E item" });
  await packVoid.getByRole("textbox", { name: "How many to void" }).fill("2");
  await packVoid.getByRole("radio", { name: "Damaged" }).click();
  await packVoid.getByRole("button", { name: "Void", exact: true }).click();
  await expect(page.getByTestId("pack-stale")).toBeVisible();

  // QA reports a Major packaging issue with a photo.
  await signInAs(page, ["QA"]);
  await page.goto(`/orders/${order.id}`);
  await page.getByRole("button", { name: "Report issue" }).click();
  const report = page.getByRole("dialog", { name: "Report an issue" });
  await report.getByLabel("Type").selectOption("PACKAGING_DAMAGE");
  await report.getByLabel("Severity").selectOption("MAJOR");
  await report.getByRole("textbox", { name: "What went wrong" }).fill("Crushed corner");
  await report.getByRole("button", { name: "Report issue" }).click();
  const chooser = page.waitForEvent("filechooser");
  await report.getByRole("button", { name: "Choose photos" }).click();
  await (await chooser).setFiles([PHOTO]);
  await report.getByRole("button", { name: "Add note" }).click();
  await expect(report).toHaveCount(0);
  await expect(page.getByTestId("issue-card")).toContainText("1 note");

  // A QA user sees the issue but no Delete.
  await page.goto("/issues");
  await page.getByRole("searchbox", { name: search }).fill(customerName);
  await expect(page.getByTestId("issue-row")).toHaveCount(1);
  await page.getByTestId("issue-row").getByRole("button", { name: "Packaging damage" }).click();
  const drawer = page.getByTestId("issue-drawer");
  await expect(drawer).toContainText("Crushed corner");
  await expect(drawer.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0);
  await expect(drawer.getByTestId("issue-delete")).toHaveCount(0);

  // An admin sees both counts, resolves the void with a note and resolves the issue.
  await signInAs(page, ["ADMIN"]);
  await page.goto("/voids");
  const voidsCount = page.getByTestId("voids-count");
  await expect(voidsCount).not.toHaveText("…");
  expect(Number(await voidsCount.textContent())).toBeGreaterThan(0);
  await page.getByRole("searchbox", { name: search }).fill(customerName);
  const voidCard = page.getByTestId("void-order").filter({ hasText: customerName });
  await expect(voidCard.getByRole("cell", { name: "Out of stock" })).toBeVisible();
  await voidCard.locator("td [aria-hidden]").first().click();
  await voidCard.locator("td [aria-hidden]").nth(1).click();
  await page.getByRole("button", { name: /^Resolve selected/ }).click();
  const resolveVoid = page.getByRole("dialog", { name: /^Resolve \d+ voids?$/ });
  await resolveVoid.getByText("Refunded", { exact: true }).click();
  await resolveVoid.getByRole("textbox", { name: "Note" }).fill("Refunded in Woo");
  await resolveVoid.getByRole("button", { name: "Mark resolved" }).click();
  await expect(voidCard).toHaveCount(0);
  expect(await db.itemVoid.count({ where: { orderId: order.id, resolvedAt: null } })).toBe(0);

  await page.goto("/issues");
  await expect(page.getByTestId("issues-count")).not.toHaveText("…");
  await page.getByRole("searchbox", { name: search }).fill(customerName);
  await expect(page.getByTestId("issue-row")).toHaveCount(1);
  await page.getByTestId("issue-row").getByRole("button", { name: "Packaging damage" }).click();
  await drawer.getByRole("button", { name: "Resolve", exact: true }).click();
  const resolveIssue = page.getByRole("dialog", { name: "Resolve issue" });
  await resolveIssue.getByRole("textbox", { name: "Note" }).fill("Repacked");
  await resolveIssue.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(drawer.getByTestId("issue-resolution")).toContainText("Repacked", {
    timeout: 15_000,
  });

  // The admin deletes the issue.
  await drawer.getByTestId("issue-delete").click();
  await page
    .getByRole("dialog", { name: "Delete issue" })
    .getByRole("button", { name: "Delete issue" })
    .click();
  await expect(drawer).toHaveCount(0);
  expect(await db.qualityIssue.count({ where: { orderId: order.id } })).toBe(0);
});

test("an all-voided order shows the banner and hides Complete", async ({ page }) => {
  const order = await createOrder({ status: "PICKING", quantity: 1 });
  await signInAs(page, ["ADMIN"]);
  await page.goto(`/orders/${order.id}`);
  await page
    .getByRole("row", { name: /E2E item/ })
    .getByRole("button", { name: "Void" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Void E2E item" });
  await dialog.getByRole("radio", { name: "Out of stock" }).click();
  await dialog.getByRole("button", { name: "Void", exact: true }).click();
  await expect(page.getByTestId("all-voided-banner")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Complete/ })).toHaveCount(0);
});
