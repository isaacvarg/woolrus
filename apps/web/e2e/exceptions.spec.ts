import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

const db = createDb();

test.afterAll(deleteCreatedOrders);

test("a picker voids 1 of 3 from the order detail, then undoes it", async ({ page }) => {
  const order = await createOrder({ quantity: 3 });
  await signInAs(page, ["PICKER"]);
  await page.goto(`/orders/${order.id}`);

  const line = page.getByRole("row", { name: /E2E item/ });
  await expect(line.getByRole("cell", { name: "3", exact: true }).last()).toBeVisible();
  await line.getByRole("button", { name: "Void" }).click();

  const dialog = page.getByRole("dialog", { name: "Void E2E item" });
  const quantity = dialog.getByRole("textbox", { name: "How many to void" });
  // The whole active quantity is the default; one unit is the missing jar.
  await expect(quantity).toHaveValue("3");
  await quantity.fill("1");
  await dialog.getByRole("radio", { name: "Out of stock" }).click();
  await expect(dialog.getByRole("textbox", { name: "Reason", exact: true })).toHaveValue(
    "Out of stock",
  );
  await dialog.getByRole("button", { name: "Void", exact: true }).click();

  await expect(page.getByText("1 of 3 voided: Out of stock")).toBeVisible();
  await expect(line.getByRole("cell", { name: "2", exact: true })).toBeVisible();

  await line.getByRole("button", { name: "Undo" }).click();

  await expect(page.getByText("1 of 3 voided: Out of stock")).toHaveCount(0);
  await expect(line.getByRole("cell", { name: "3", exact: true })).toHaveCount(2);
});

test("a completed order offers no void", async ({ page }) => {
  const order = await createOrder({ status: "COMPLETED" });
  await signInAs(page, ["ADMIN"]);
  await page.goto(`/orders/${order.id}`);

  await expect(page.getByRole("row", { name: /E2E item/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Void" })).toHaveCount(0);
});

test("a packer voids a boxed unit from the pack screen and sees the re-weigh flag", async ({
  page,
}) => {
  const order = await createOrder({ quantity: 3, status: "PACKING" });
  const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  const pkg = await db.package.create({
    data: { orderId: order.id, number: 1, lengthIn: 12, widthIn: 9, heightIn: 4, weightOz: 16 },
  });
  await db.packageItem.create({
    data: { packageId: pkg.id, orderItemId: item.id, quantity: 2 },
  });
  // Nobody holds a claim: voiding needs none.
  await signInAs(page, ["PACKER"]);
  await page.goto(`/pack/${order.id}`);

  const card = page.getByTestId("pack-item");
  await expect(card.getByTestId("pack-left")).toHaveText("1 left");
  await card.getByRole("button", { name: "Void" }).click();
  const dialog = page.getByRole("dialog", { name: "Void E2E item" });
  await dialog.getByRole("textbox", { name: "How many to void" }).fill("2");
  await dialog.getByRole("radio", { name: "Damaged" }).click();
  await dialog.getByRole("button", { name: "Void", exact: true }).click();

  // 3 -> 1 active: the unassigned unit and one boxed unit are gone, the weight stays flagged.
  await expect(page.getByTestId("pack-stale")).toBeVisible();
  await expect(page.getByTestId("pack-all-packed")).toBeVisible();
});

test("voiding every line shows the all-voided banner, hides Complete, and the order can be cancelled", async ({
  page,
}) => {
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

  await expect(page.getByTestId("all-voided-banner")).toContainText("Every item is voided");
  await expect(page.getByRole("button", { name: /^Complete/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Cancel order" }).click();
  const cancel = page.getByRole("dialog", { name: "Cancel this order" });
  await cancel.getByRole("textbox", { name: "Reason" }).fill("Nothing left to ship");
  await cancel.getByRole("button", { name: "Cancel order" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Cancelled");
});

// A small real PNG (32×24), so the server's image checks run.
const PHOTO = {
  name: "dent.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMElEQVRIiWM4Y2xMU8QwaoHxaBAZj6aiM6MZzXi0qDgzWpoaj1Y4Z0arTOPB3aoAANDIli6iRyQsAAAAAElFTkSuQmCC",
    "base64",
  ),
};

test("QA reports a Major packaging issue with a photo from the order detail", async ({ page }) => {
  const order = await createOrder({ status: "QA" });
  await signInAs(page, ["QA"]);
  await page.goto(`/orders/${order.id}`);

  await page.getByRole("button", { name: "Report issue" }).click();
  const dialog = page.getByRole("dialog", { name: "Report an issue" });
  await dialog.getByLabel("Type").selectOption("PACKAGING_DAMAGE");
  await dialog.getByLabel("Severity").selectOption("MAJOR");
  await dialog.getByRole("textbox", { name: "What went wrong" }).fill("Crushed corner");
  await expect(dialog.getByTestId("issue-discovered")).toHaveText("QA");
  await dialog.getByLabel("Where it started").selectOption("PACKING");
  await dialog.getByRole("button", { name: "Report issue" }).click();

  // Evidence goes on the new issue through the notes composer; the photo is optional.
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose photos" }).click();
  await (await chooser).setFiles([PHOTO]);
  await dialog.getByRole("button", { name: "Add note" }).click();
  await expect(dialog).toHaveCount(0);

  const card = page.getByTestId("issue-card");
  await expect(card).toContainText("Packaging damage");
  await expect(card).toContainText("Major");
  await expect(card).toContainText("Found in QA");
  await expect(card).toContainText("Started in Packing");
  await expect(card).toContainText("1 note");
});

test("an issue can be reported without evidence", async ({ page }) => {
  const order = await createOrder({ status: "READY" });
  await signInAs(page, ["SHIPPER"]);
  await page.goto(`/orders/${order.id}`);

  await page.getByRole("button", { name: "Report issue" }).click();
  const dialog = page.getByRole("dialog", { name: "Report an issue" });
  await dialog.getByRole("textbox", { name: "What went wrong" }).fill("Wrong scent");
  await dialog.getByText("The customer reported this").click();
  await expect(dialog.getByTestId("issue-discovered")).toHaveText("Customer");
  await dialog.getByRole("button", { name: "Report issue" }).click();
  await dialog.getByRole("button", { name: "Skip" }).click();

  await expect(page.getByTestId("issue-card")).toContainText("Customer-reported");
});

test("an admin resolves a void with a note on the Voids page and the nav count drops", async ({
  page,
}) => {
  const customerName = `E2E voids ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, status: "PICKING", quantity: 3 });
  const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  await db.itemVoid.create({
    data: {
      orderId: order.id,
      orderItemId: item.id,
      quantity: 1,
      reason: "Out of stock",
      stage: "PICKING",
    },
  });
  await signInAs(page, ["ADMIN"]);
  await page.goto("/voids");

  const count = page.getByTestId("voids-count");
  await expect(count).not.toHaveText("…");
  const before = Number(await count.textContent());
  expect(before).toBeGreaterThan(0);

  await page
    .getByRole("searchbox", { name: "Search by order number or customer" })
    .fill(customerName);
  const card = page.getByTestId("void-order").filter({ hasText: customerName });
  await expect(card.getByRole("cell", { name: "Out of stock" })).toBeVisible();

  const box = card.getByRole("checkbox", { name: "Select void of E2E item" });
  // The box is visually hidden behind its styled square: tap the square, as a person would.
  await card.locator("td [aria-hidden]").first().click();
  await expect(box).toBeChecked();
  await page.getByRole("button", { name: "Resolve selected (1)" }).click();
  const dialog = page.getByRole("dialog", { name: "Resolve 1 void" });
  // A note is required.
  await dialog.getByRole("button", { name: "Mark resolved" }).click();
  await expect(dialog.getByText("This field is required.")).toBeVisible();
  await dialog.getByText("Refunded", { exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "Refunded" })).toBeChecked();
  await dialog.getByRole("textbox", { name: "Note" }).fill("Refunded $14 in Woo");
  await dialog.getByRole("button", { name: "Mark resolved" }).click();

  await expect(card).toHaveCount(0);
  await expect.poll(async () => Number(await count.textContent())).toBeLessThan(before);

  await page.getByRole("tab", { name: "Resolved", exact: true }).click();
  await expect(
    page.getByTestId("void-order").filter({ hasText: customerName }).getByText("Refunded by", {
      exact: false,
    }),
  ).toBeVisible();
  expect(await db.itemVoid.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({
    resolution: "REFUNDED",
    resolutionNotes: "Refunded $14 in Woo",
    wooRefundId: null,
  });
});

test("an admin filters Issues to Open, resolves one with a note, then reopens it", async ({
  page,
}) => {
  const customerName = `E2E issues ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, status: "QA" });
  const make = (severity: "MINOR" | "CRITICAL", description: string) =>
    db.qualityIssue.create({
      data: {
        orderId: order.id,
        type: "PACKAGING_DAMAGE",
        severity,
        description,
        discoveredStage: "QA",
      },
    });
  const minor = await make("MINOR", "Scuffed label");
  await make("CRITICAL", "Leaking bottle");
  await signInAs(page, ["ADMIN"]);
  await page.goto("/issues");

  await expect(page.getByTestId("issues-count")).not.toHaveText("…");
  // The nav sits in a closed drawer on a tablet, so check it is there, not that it shows.
  await expect(page.getByTestId("issues-critical")).toBeAttached();
  await page
    .getByRole("searchbox", { name: "Search by order number or customer" })
    .fill(customerName);
  const rows = page.getByTestId("issue-row");
  await expect(rows).toHaveCount(2);
  // Open Critical first, with the word as well as the colour.
  await expect(rows.first()).toContainText("Critical");
  await expect(rows.first()).toContainText("Leaking bottle");

  await page.getByRole("tab", { name: "Open", exact: true }).click();
  await expect(rows).toHaveCount(2);

  // The row opens a drawer with the details; resolving needs a note.
  await rows.nth(1).getByRole("button", { name: "Packaging damage" }).click();
  const drawer = page.getByTestId("issue-drawer");
  await expect(drawer).toContainText("Scuffed label");
  await drawer.getByRole("button", { name: "Resolve", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resolve issue" });
  await dialog.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(dialog.getByText("This field is required.")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Note" }).fill("Relabelled");
  await dialog.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(drawer.getByTestId("issue-resolution")).toContainText("Relabelled", {
    timeout: 15_000,
  });
  expect(await db.qualityIssue.findUniqueOrThrow({ where: { id: minor.id } })).toMatchObject({
    status: "RESOLVED",
    resolutionNotes: "Relabelled",
  });

  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole("tab", { name: "Resolved", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole("button", { name: "Packaging damage" }).click();
  await drawer.getByRole("button", { name: "Reopen" }).click();
  await expect(drawer.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
  expect(await db.qualityIssue.findUniqueOrThrow({ where: { id: minor.id } })).toMatchObject({
    status: "OPEN",
    resolutionNotes: null,
  });
  await expect(drawer).toContainText("Relabelled", { timeout: 15_000 });
});

test("a QA user sees Issues but no resolve controls", async ({ page }) => {
  const customerName = `E2E issues ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, status: "QA" });
  await db.qualityIssue.create({
    data: {
      orderId: order.id,
      type: "OTHER",
      severity: "MAJOR",
      description: "Odd smell",
      discoveredStage: "QA",
    },
  });
  await signInAs(page, ["QA"]);
  await page.goto("/issues");
  await page
    .getByRole("searchbox", { name: "Search by order number or customer" })
    .fill(customerName);
  await expect(page.getByTestId("issue-row")).toHaveCount(1);
  await page
    .getByTestId("issue-row")
    .filter({ hasText: "Odd smell" })
    .getByRole("button", { name: "Other" })
    .click();
  const drawer = page.getByTestId("issue-drawer");
  await expect(drawer).toContainText("Odd smell");
  await expect(drawer.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Delete" })).toHaveCount(0);
});

test("an admin deletes an issue from the drawer", async ({ page }) => {
  const customerName = `E2E issues ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, status: "QA" });
  const issue = await db.qualityIssue.create({
    data: {
      orderId: order.id,
      type: "OTHER",
      severity: "MINOR",
      description: "Delete me",
      discoveredStage: "QA",
    },
  });
  await signInAs(page, ["ADMIN"]);
  await page.goto("/issues");
  await page
    .getByRole("searchbox", { name: "Search by order number or customer" })
    .fill(customerName);
  await expect(page.getByTestId("issue-row")).toHaveCount(1);
  await page.getByTestId("issue-row").getByRole("button", { name: "Other" }).click();
  const drawer = page.getByTestId("issue-drawer");
  await drawer.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete issue" });
  await dialog.getByRole("button", { name: "Delete issue" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId("issue-row")).toHaveCount(0);
  expect(await db.qualityIssue.count({ where: { id: issue.id } })).toBe(0);
});

test("a picker reports an issue from the pick screen and the queue row shows the badge", async ({
  page,
}) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, quantity: 2 });
  await signInAs(page, ["PICKER"]);
  await page.goto("/queue/pending");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  const row = page.getByRole("row", { name: new RegExp(order.number) });
  await expect(row.getByTestId("queue-issue-badge")).toHaveCount(0);
  await row.getByRole("button", { name: "Begin Picking" }).click();
  await expect(page).toHaveURL(`/pick/${order.id}`);

  const card = page.getByTestId("pick-card").first();
  await card.getByRole("button", { name: "More for E2E item" }).click();
  await page.getByRole("menuitem", { name: "Report issue" }).click();
  const dialog = page.getByRole("dialog", { name: "Report an issue" });
  await expect(dialog.getByRole("combobox", { name: "About" })).toHaveValue(/^item:/);
  await dialog.getByRole("textbox", { name: "What went wrong" }).fill("Lid cracked");
  await dialog.getByRole("button", { name: "Report issue" }).click();
  await dialog.getByRole("button", { name: "Skip" }).click();
  await expect(dialog).toBeHidden();

  const saved = await db.qualityIssue.findFirstOrThrow({ where: { orderId: order.id } });
  expect(saved.orderItemId).not.toBeNull();

  // A second tab's queue row carries the badge.
  await page.goto("/queue/picking");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await expect(
    page.getByRole("row", { name: new RegExp(order.number) }).getByTestId("queue-issue-badge"),
  ).toHaveAttribute("data-severity", "MINOR");
});

test("a packer reports a packaging issue on a package, linked to it", async ({ page }) => {
  const order = await createOrder({ quantity: 2, status: "PACKING" });
  const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  const pkg = await db.package.create({
    data: { orderId: order.id, number: 1, lengthIn: 12, widthIn: 9, heightIn: 4 },
  });
  await db.packageItem.create({ data: { packageId: pkg.id, orderItemId: item.id, quantity: 1 } });
  await signInAs(page, ["PACKER"]);
  await page.goto(`/pack/${order.id}`);

  await page
    .getByTestId("pack-package")
    .getByRole("button", { name: "Report packaging issue" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Report an issue" });
  await dialog.getByRole("combobox", { name: "Type" }).selectOption("PACKAGING_DAMAGE");
  await dialog.getByRole("textbox", { name: "What went wrong" }).fill("Box crushed");
  await dialog.getByRole("button", { name: "Report issue" }).click();
  await dialog.getByRole("button", { name: "Skip" }).click();
  await expect(dialog).toBeHidden();

  const saved = await db.qualityIssue.findFirstOrThrow({ where: { orderId: order.id } });
  expect(saved.packageId).toBe(pkg.id);
  expect(saved.type).toBe("PACKAGING_DAMAGE");
});

test("the issue count and assignee routes are not read as an issue id, and leak no emails", async ({
  page,
}) => {
  await signInAs(page, ["PICKER"]);

  const counts = await page.request.get("/api/v1/issues/counts");
  expect(counts.status()).toBe(200);
  expect(await counts.json()).toEqual({
    open: expect.any(Number),
    openCritical: expect.any(Number),
  });

  const assignees = await page.request.get("/api/v1/issues/assignees");
  expect(assignees.status()).toBe(200);
  const people = (await assignees.json()) as { id: string; name: string }[];
  expect(people.length).toBeGreaterThan(0);
  expect(JSON.stringify(people)).not.toContain("@");
});

test("the issue routes refuse a caller who isn't signed in", async ({ request }) => {
  for (const path of ["/api/v1/issues/counts", "/api/v1/issues/assignees", "/api/v1/issues"]) {
    expect((await request.get(path)).status(), path).toBe(401);
  }
});
