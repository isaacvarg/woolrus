import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";
import { createOrder, deleteCreatedOrders } from "./support/orders";

// Lot lookup (SPEC-lumexia criterion 12, ticket #167): find every order that shipped a lot, and
// download the same rows as CSV. Each run uses its own item code, so parallel runs never meet.

const db = createDb();
test.afterAll(() => deleteCreatedOrders());

/** An order with one package holding all its units under `lotNumber`. */
async function orderWithLot(lotNumber: string, quantity: number, status: "COMPLETED" | "QA") {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, quantity, status });
  if (status === "COMPLETED") {
    await db.order.update({ where: { id: order.id }, data: { completedAt: new Date() } });
  }
  const line = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  await db.package.create({
    data: {
      orderId: order.id,
      number: 1,
      items: {
        create: {
          orderItemId: line.id,
          quantity,
          lots: { create: { lotNumber, quantity, position: 0, status: "VALID" } },
        },
      },
    },
  });
  return { ...order, customerName };
}

test("look up a lot, see every order that holds it, and download the CSV", async ({ page }) => {
  const ref = `E2E${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const lot = `${ref}.A12A0124`;
  const shipped = await orderWithLot(lot, 2, "COMPLETED");
  const inQa = await orderWithLot(lot, 1, "QA");

  // Everyone with order.read: a picker.
  await signInAs(page, ["PICKER"]);
  await page.goto("/");
  await openNav(page);
  await page.getByRole("navigation").getByRole("link", { name: "Lot lookup" }).click();
  await expect(page).toHaveURL("/lots");

  // A scanner types into the focused field and presses Enter; case doesn't matter.
  await page.getByLabel("Lot number or QR code").fill(lot.toLowerCase());
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("lot-lookup-count")).toHaveText(
    `2 package items hold lot ${lot.toLowerCase()}.`,
  );
  const rows = page.getByTestId("lot-lookup-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: shipped.customerName })).toContainText("Valid");
  await expect(rows.filter({ hasText: inQa.customerName })).toContainText("Not shipped");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`lot-${lot.toLowerCase()}.csv`);
  const text = (await readFile(await download.path())).toString("utf8");
  const lines = text.replace(/^﻿/, "").trimEnd().split("\r\n");
  expect(lines[0]).toBe("Order,Customer,Package,Product,Lot,Quantity,Lot status,Shipped");
  expect(lines).toHaveLength(3);
  // Same rows, same order as the screen: the order not shipped yet comes first.
  expect(lines[1]).toMatch(
    new RegExp(`^${inQa.number},${inQa.customerName},1,E2E item,${lot},1,VALID,$`),
  );
  expect(lines[2]).toMatch(
    new RegExp(`^${shipped.number},${shipped.customerName},1,E2E item,${lot},2,VALID,\\d{4}-`),
  );

  // The order detail page shows the lot with its status.
  await rows.filter({ hasText: shipped.customerName }).getByRole("link").click();
  await expect(page).toHaveURL(`/orders/${shipped.id}`);
  await expect(page.getByTestId("lot-chip")).toHaveAccessibleName("2 from lot A12A0124, Valid");

  // An unknown lot finds nothing, and no CSV is offered.
  await page.goto("/lots");
  await page.getByLabel("Lot number or QR code").fill(`${ref}.Z99L3199`);
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.getByTestId("lot-lookup-count")).toHaveText(
    `No package holds lot ${ref}.Z99L3199.`,
  );
  await expect(page.getByRole("link", { name: "Download CSV" })).toHaveCount(0);
});

test("the lot CSV needs a session and a code", async ({ page }) => {
  expect((await page.request.get("/api/lots/export.csv?code=X")).status()).toBe(401);
  await signInAs(page, ["PICKER"]);
  expect((await page.request.get("/api/lots/export.csv")).status()).toBe(400);
});
