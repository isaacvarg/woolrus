import type { Db, LabelStatus } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { fakeProvider, verifiedQaOrder } from "../../test/qa-fixtures";
import { ShippingError } from "../adapters/shipping/errors";
import { voidLabel } from "./labels";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

/** A QA order whose package 1 holds a label in `status`. */
async function labelled(status: LabelStatus = "ACTIVE") {
  const built = await verifiedQaOrder(db, 2);
  const [p1] = built.packages;
  if (!p1) throw new Error("packages");
  const label = await db.shippingLabel.create({
    data: {
      packageId: p1.id,
      status,
      provider: "SHIPSTATION",
      idempotencyKey: `k-${status}`,
      providerLabelId: "se-label-1",
      carrierCode: "demo_ground",
      serviceCode: "demo_ground",
      currency: "USD",
    },
  });
  const provider = fakeProvider();
  const run = (
    actor = built.qa,
    input: { reason?: string } = {},
    providers = [provider as ReturnType<typeof fakeProvider>],
  ) =>
    voidLabel(
      db,
      actor,
      { labelId: label.id, reason: input.reason ?? "Wrong address" },
      { providers },
    );
  return { ...built, p1, label, provider, run };
}

const row = (id: string) => db.shippingLabel.findUniqueOrThrow({ where: { id } });

describe("voidLabel", () => {
  it("voids an approved label, records who and why, and frees the package", async () => {
    const { run, label, qa, p1 } = await labelled();

    const result = await run();

    const after = await row(label.id);
    expect(after).toMatchObject({
      status: "VOIDED",
      voidedById: qa.userId,
      voidReason: "Wrong address",
      error: null,
    });
    expect(after.voidRequestedAt).not.toBeNull();
    expect(after.voidedAt).not.toBeNull();
    expect(result.packages.find((p) => p.id === p1.id)?.label?.status).toBe("VOIDED");
    expect(await db.auditEvent.count({ where: { action: "label.void", entityId: label.id } })).toBe(
      1,
    );
    // The package can take a new label: the live-label unique index no longer holds it.
    await db.shippingLabel.create({
      data: {
        packageId: p1.id,
        status: "PURCHASING",
        provider: "SHIPSTATION",
        idempotencyKey: "again",
        carrierCode: "demo_ground",
        serviceCode: "demo_ground",
        currency: "USD",
      },
    });
  });

  it("writes VOID_REQUESTED before it calls the provider", async () => {
    const { run, label, provider } = await labelled();
    let during: LabelStatus | undefined;
    vi.spyOn(provider, "voidLabel").mockImplementation(async () => {
      during = (await row(label.id)).status;
      return { approved: true };
    });

    await run();

    expect(during).toBe("VOID_REQUESTED");
  });

  it("keeps a declined label live as VOID_REJECTED", async () => {
    const { run, label, provider } = await labelled();
    vi.spyOn(provider, "voidLabel").mockResolvedValue({ approved: false, message: "Too late" });

    await run();

    expect(await row(label.id)).toMatchObject({
      status: "VOID_REJECTED",
      error: "errors.qa.voidRejected",
      voidedAt: null,
    });
    // Still live: the row is kept and blocks its package.
    await expect(run()).rejects.toMatchObject({ messageKey: "errors.qa.labelNotVoidable" });
  });

  it("leaves VOID_REQUESTED after a transient failure, and the void can be repeated", async () => {
    const { run, label, provider } = await labelled();
    const spy = vi
      .spyOn(provider, "voidLabel")
      .mockRejectedValueOnce(new ShippingError("unavailable", "voidLabel 503"));

    await expect(run()).rejects.toMatchObject({ messageKey: "errors.shipping.unavailable" });
    expect((await row(label.id)).status).toBe("VOID_REQUESTED");

    spy.mockResolvedValue({ approved: true });
    await run();
    expect((await row(label.id)).status).toBe("VOIDED");
  });

  it("refuses a provider without void", async () => {
    const { run, label, provider } = await labelled();
    Object.assign(provider, { capabilities: { ...provider.capabilities, void: false } });

    await expect(run()).rejects.toMatchObject({ messageKey: "errors.qa.voidUnsupported" });
    expect((await row(label.id)).status).toBe("ACTIVE");
  });

  it.each(["PURCHASING", "PURCHASE_FAILED", "VOIDED", "VOID_REJECTED"] as const)(
    "refuses a %s label",
    async (status) => {
      const { run } = await labelled(status);
      await expect(run()).rejects.toMatchObject({ messageKey: "errors.qa.labelNotVoidable" });
    },
  );

  it("refuses an order that isn't in QA", async () => {
    const { run, order, label } = await labelled();
    await db.order.update({ where: { id: order.id }, data: { status: "READY" } });
    await expect(run()).rejects.toMatchObject({ messageKey: "errors.qa.notQa" });
    expect((await row(label.id)).status).toBe("ACTIVE");
  });

  it("lets Admin void without holding the claim", async () => {
    const { run, label } = await labelled();
    await run(await createActor(db, ["ADMIN"]));
    expect((await row(label.id)).status).toBe("VOIDED");
  });

  it.each(["SHIPPER", "PACKER"] as const)("forbids a %s", async (role) => {
    const { run, label } = await labelled();
    await expect(run(await createActor(db, [role]))).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect((await row(label.id)).status).toBe("ACTIVE");
  });

  it("requires a reason", async () => {
    const { run } = await labelled();
    await expect(run(undefined, { reason: "  " })).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });
});
