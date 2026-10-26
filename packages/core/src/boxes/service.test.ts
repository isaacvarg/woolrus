import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { archiveBox, createBox, deleteBox, listBoxes, restoreBox, updateBox } from "./service";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const input = {
  idempotencyKey: "key-00000001",
  name: "Medium box",
  lengthIn: 10,
  widthIn: 8.5,
  heightIn: 4,
  maxWeightOz: 320,
  tareWeightOz: null,
  outerLengthIn: null,
  outerWidthIn: null,
  outerHeightIn: null,
};

describe("box service", () => {
  it("creates, lists and archives a box, with an audit trail", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const box = await createBox(db, admin, input);
    expect(box).toMatchObject({
      name: "Medium box",
      widthIn: 8.5,
      maxWeightOz: 320,
      archived: false,
    });

    await archiveBox(db, admin, { id: box.id });
    expect(await listBoxes(db, admin, { includeArchived: false })).toEqual([]);
    expect(await listBoxes(db, admin, { includeArchived: true })).toHaveLength(1);

    const audit = await db.auditEvent.findMany({
      where: { entityId: box.id },
      orderBy: { at: "asc" },
    });
    expect(audit.map((e) => e.action)).toEqual(["create", "archive"]);
  });

  it("returns the original result when a create is replayed", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const first = await createBox(db, admin, input);
    const replay = await createBox(db, admin, input);
    expect(replay).toEqual(first);
    expect(await db.box.count()).toBe(1);
  });

  it("rejects duplicate names with a translatable error", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await createBox(db, admin, input);
    await expect(
      createBox(db, admin, { ...input, idempotencyKey: "key-00000002" }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.box.nameTaken",
    });
  });

  it("forbids non-admins from creating boxes", async () => {
    const picker = await createActor(db, ["PICKER"]);
    await expect(createBox(db, picker, input)).rejects.toThrowError("errors.forbidden");
  });

  it("stores optional outer dimensions: all three or none, none smaller than inner", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const box = await createBox(db, admin, {
      ...input,
      outerLengthIn: 10.5,
      outerWidthIn: 9,
      outerHeightIn: 4.5,
    });
    expect(box).toMatchObject({ outerLengthIn: 10.5, outerWidthIn: 9, outerHeightIn: 4.5 });
    expect(box.inUse).toBe(false);

    await expect(
      createBox(db, admin, {
        ...input,
        idempotencyKey: "key-00000002",
        name: "B",
        outerLengthIn: 11,
      }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
    await expect(
      createBox(db, admin, {
        ...input,
        idempotencyKey: "key-00000003",
        name: "C",
        outerLengthIn: 9,
        outerWidthIn: 9,
        outerHeightIn: 5,
      }),
    ).rejects.toMatchObject({ messageKey: "errors.box.outerSmaller" });
  });

  it("updates an unused box in full, with before/after audit", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const box = await createBox(db, admin, input);
    const updated = await updateBox(db, admin, {
      id: box.id,
      name: "Bigger",
      lengthIn: 12,
      maxWeightOz: 400,
      tareWeightOz: 5,
      outerLengthIn: 12.5,
      outerWidthIn: 9,
      outerHeightIn: 4.5,
    });
    expect(updated).toMatchObject({
      name: "Bigger",
      lengthIn: 12,
      widthIn: 8.5,
      maxWeightOz: 400,
      tareWeightOz: 5,
      outerLengthIn: 12.5,
    });
    const audit = await db.auditEvent.findFirst({
      where: { entityId: box.id, action: "update" },
    });
    expect(audit?.before).toMatchObject({ name: "Medium box" });
    expect(audit?.after).toMatchObject({ name: "Bigger", lengthIn: 12 });

    await expect(updateBox(db, admin, { id: box.id, outerLengthIn: 5 })).rejects.toMatchObject({
      messageKey: "errors.box.outerSmaller",
    });
  });

  it("locks dimensions on a used box but still edits name, max and tare", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { packages } = await createOrder(db, { status: "PACKING", packages: [{}] });
    const id = packages[0]?.boxId as string;
    expect((await listBoxes(db, admin, { includeArchived: true }))[0]?.inUse).toBe(true);

    await expect(updateBox(db, admin, { id, lengthIn: 20 })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.box.dimensionsLocked",
    });
    await expect(
      updateBox(db, admin, { id, outerLengthIn: 20, outerWidthIn: 20, outerHeightIn: 20 }),
    ).rejects.toMatchObject({ messageKey: "errors.box.dimensionsLocked" });
    const ok = await updateBox(db, admin, {
      id,
      name: "Renamed",
      maxWeightOz: 99,
      tareWeightOz: 3,
    });
    expect(ok).toMatchObject({ name: "Renamed", maxWeightOz: 99, tareWeightOz: 3, inUse: true });
    // Re-sending the unchanged dimensions is not a change.
    await expect(
      updateBox(db, admin, { id, lengthIn: 10, widthIn: 8, heightIn: 4 }),
    ).resolves.toBeDefined();
  });

  it("keeps names unique on update", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await createBox(db, admin, input);
    const other = await createBox(db, admin, {
      ...input,
      idempotencyKey: "key-00000002",
      name: "Other",
    });
    await expect(updateBox(db, admin, { id: other.id, name: "Medium box" })).rejects.toMatchObject({
      messageKey: "errors.box.nameTaken",
    });
  });

  it("restores an archived box and deletes only an unused one, both audited", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const box = await createBox(db, admin, input);
    await archiveBox(db, admin, { id: box.id });
    expect(await restoreBox(db, admin, { id: box.id })).toMatchObject({ archived: false });

    const { packages } = await createOrder(db, { status: "PACKING", packages: [{}] });
    await expect(deleteBox(db, admin, { id: packages[0]?.boxId as string })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.box.inUse",
    });

    await deleteBox(db, admin, { id: box.id });
    expect(await db.box.findUnique({ where: { id: box.id } })).toBeNull();
    const audit = await db.auditEvent.findMany({
      where: { entityId: box.id },
      orderBy: { at: "asc" },
    });
    expect(audit.map((e) => e.action)).toEqual(["create", "archive", "restore", "delete"]);
  });

  it("forbids non-admins from editing, restoring or deleting boxes", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const packer = await createActor(db, ["PACKER"]);
    const box = await createBox(db, admin, input);
    await expect(updateBox(db, packer, { id: box.id, name: "X" })).rejects.toThrowError(
      "errors.forbidden",
    );
    await expect(restoreBox(db, packer, { id: box.id })).rejects.toThrowError("errors.forbidden");
    await expect(deleteBox(db, packer, { id: box.id })).rejects.toThrowError("errors.forbidden");
    expect(await listBoxes(db, packer, { includeArchived: false })).toHaveLength(1);
  });
});

describe("box admin: guards and races", () => {
  it("forbids a Packer from archiving or creating boxes", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const packer = await createActor(db, ["PACKER"]);
    const box = await createBox(db, admin, input);

    await expect(archiveBox(db, packer, { id: box.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    await expect(createBox(db, packer, { ...input, name: "Other" })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect((await listBoxes(db, admin, { includeArchived: true }))[0]?.archived).toBe(false);
  });

  it("counts a package on any order as use, however old, so the box can't be deleted", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const box = await createBox(db, admin, input);
    await createOrder(db, { status: "COMPLETED", packages: [{ items: [] }] });
    const { packages } = await createOrder(db, { status: "COMPLETED", packages: [{ items: [] }] });
    await db.package.update({ where: { id: packages[0]?.id }, data: { boxId: box.id } });

    await expect(deleteBox(db, admin, { id: box.id })).rejects.toMatchObject({
      messageKey: "errors.box.inUse",
    });
    expect((await listBoxes(db, admin, { includeArchived: false }))[0]).toMatchObject({
      inUse: true,
    });
  });

  it("refuses to shrink the outer size below the inner on update", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const box = await createBox(db, admin, {
      ...input,
      outerLengthIn: 11,
      outerWidthIn: 9.5,
      outerHeightIn: 5,
    });

    await expect(updateBox(db, admin, { id: box.id, outerLengthIn: 9 })).rejects.toMatchObject({
      messageKey: "errors.box.outerSmaller",
    });
  });

  it("a delete waits for a package being added and is then refused, not a server error", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const box = await createBox(db, admin, input);
    const { order } = await createOrder(db, { status: "PACKING" });

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted!: () => void;
    const isInserted = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    // Another packer's addPackage, mid-transaction: the package row exists but isn't committed.
    const adding = db.$transaction(
      async (tx) => {
        await tx.package.create({ data: { orderId: order.id, number: 1, boxId: box.id } });
        inserted();
        await released;
      },
      { timeout: 20_000 },
    );
    await isInserted;

    const deleting = deleteBox(db, admin, { id: box.id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await adding;

    await expect(deleting).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.box.inUse",
    });
    expect(await db.box.count({ where: { id: box.id } })).toBe(1);
  });
});
