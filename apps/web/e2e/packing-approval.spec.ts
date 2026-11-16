import { expect, test } from "@playwright/test";
import { hashPin } from "@woolrus/core";
import { createDb, type PackCheckMode } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { withSettingsLock } from "./support/settings-lock";

// SPEC-packing A1 criterion 28, pack half: a check set to block stops Complete packing until a QA
// user approves it in person at the packer's tablet.

const db = createDb();
const boxIds: string[] = [];
const PIN = "482916";

test.afterAll(async () => {
  await deleteCreatedOrders();
  await db.box.deleteMany({ where: { id: { in: boxIds.splice(0) }, packages: { none: {} } } });
});

test("tablet: a blocking NO_FIT trip needs a QA user's PIN and reason to complete", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "tablet", "the floor runs on tablets");
  test.slow();

  // The mode is warehouse-wide: tests that change settings take turns through the lock, and it is
  // put back however the test ends.
  await withSettingsLock(async () => {
    const before = await db.settings.findFirst({ select: { packCheckNoFit: true } });
    const setNoFit = (mode: PackCheckMode) =>
      db.settings.upsert({
        where: { id: 1 },
        create: { id: 1, packCheckNoFit: mode },
        update: { packCheckNoFit: mode },
      });
    await setNoFit("BLOCK");
    try {
      const small = await db.box.create({
        data: { name: `E2E Small ${crypto.randomUUID()}`, lengthIn: 6, widthIn: 4, heightIn: 2 },
      });
      boxIds.push(small.id);
      const qaName = `E2E QA ${crypto.randomUUID().slice(0, 8)}`;
      await db.user.create({
        data: {
          name: qaName,
          email: `e2e-${crypto.randomUUID()}@example.test`,
          emailVerified: true,
          roles: ["QA"],
          pinHash: await hashPin(PIN),
        },
      });

      // A 5-gallon pail, too tall for the Small box.
      const customerName = `E2E ${crypto.randomUUID()}`;
      const order = await createOrder({
        customerName,
        quantity: 1,
        status: "PACKING",
        productSize: { weightOz: 16, lengthIn: 7, widthIn: 7, heightIn: 8 },
      });
      await signInAs(page, ["PACKER"]);
      await page.goto("/queue/packing");
      await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
      await page
        .getByRole("row", { name: new RegExp(order.number) })
        .getByRole("button", { name: "Start packing" })
        .click();
      await expect(page).toHaveURL(`/pack/${order.id}`, { timeout: 20_000 });

      await page.getByRole("button", { name: "Add package" }).click();
      await page
        .getByRole("dialog", { name: "Choose a box" })
        .getByRole("button", { name: small.name })
        .click();
      const pkg = page.getByTestId("pack-package");
      await page.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
      await pkg.getByLabel("lb", { exact: true }).fill("1");
      await pkg.getByRole("button", { name: "Save weight" }).click();
      await expect(pkg.getByTestId("pack-weight")).toHaveText("1 lb");

      // The block trip is red and says it needs approval.
      const trip = pkg.locator("[data-check=NO_FIT]");
      await expect(trip).toHaveClass(/alert-error/);
      await expect(trip).toContainText("Needs approval to complete");

      await page.getByRole("button", { name: "Done (needs approval)" }).click();
      const dialog = page.getByRole("dialog", { name: "Approve packing checks" });
      await expect(dialog.getByTestId("approval-trip")).toContainText("Package 1:");
      await dialog.getByLabel("Reason").fill("Pail rides on top, taped");
      await dialog.getByRole("button", { name: qaName }).click();

      // A wrong PIN is refused in place, and nothing moves.
      await dialog.getByLabel(`PIN for ${qaName}`).fill("111112");
      await expect(dialog.getByRole("alert")).toContainText("That PIN isn't right.");
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "PACKING",
      );

      await dialog.getByLabel(`PIN for ${qaName}`).fill(PIN);
      await expect(page).toHaveURL(/\/queue\/packing$/, { timeout: 20_000 });
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("QA");
      const approval = await db.approval.findFirstOrThrow({ where: { entityId: order.id } });
      expect(approval.reason).toBe("Pail rides on top, taped");
    } finally {
      await setNoFit(before?.packCheckNoFit ?? "WARN");
    }
  });
});
