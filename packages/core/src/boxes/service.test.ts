import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { archiveBox, createBox, listBoxes } from "./service";

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
});
