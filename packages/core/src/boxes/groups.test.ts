import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import {
  createBoxGroup,
  deleteBoxGroup,
  listBoxGroups,
  moveBoxGroup,
  renameBoxGroup,
} from "./groups";
import { archiveBox, createBox } from "./service";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

let keys = 0;
const key = () => `key-${String(++keys).padStart(8, "0")}`;

const boxInput = (name: string, groupId: string | null) => ({
  idempotencyKey: key(),
  name,
  lengthIn: 10,
  widthIn: 8,
  heightIn: 4,
  minWeightOz: null,
  maxWeightOz: null,
  tareWeightOz: null,
  outerLengthIn: null,
  outerWidthIn: null,
  outerHeightIn: null,
  barcode: null,
  groupId,
});

const auditFor = (entityId: string) =>
  db.auditEvent.findMany({ where: { entityId }, orderBy: { at: "asc" } });

describe("box groups (SPEC-packing A2, criterion 29)", () => {
  it("creates groups at the end and lists them in order with active box counts", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const mailers = await createBoxGroup(db, admin, { idempotencyKey: key(), name: "  Mailers " });
    const cartons = await createBoxGroup(db, admin, { idempotencyKey: key(), name: "Cartons" });
    expect(mailers).toMatchObject({ name: "Mailers", boxCount: 0 });
    expect(cartons.position).toBeGreaterThan(mailers.position);

    await createBox(db, admin, boxInput("Small", cartons.id));
    const archived = await createBox(db, admin, boxInput("Old", cartons.id));
    await archiveBox(db, admin, { id: archived.id });

    const list = await listBoxGroups(db, admin);
    expect(list.map((g) => [g.name, g.boxCount])).toEqual([
      ["Mailers", 0],
      ["Cartons", 1],
    ]);
    expect((await auditFor(mailers.id)).map((e) => e.action)).toEqual(["create"]);
  });

  it("replays a create with the same key", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const input = { idempotencyKey: key(), name: "Mailers" };
    const first = await createBoxGroup(db, admin, input);
    expect(await createBoxGroup(db, admin, input)).toEqual(first);
    expect(await db.boxGroup.count()).toBe(1);
  });

  it("refuses a name another group has after trimming and ignoring case", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await createBoxGroup(db, admin, { idempotencyKey: key(), name: "Mailers" });
    const cartons = await createBoxGroup(db, admin, { idempotencyKey: key(), name: "Cartons" });
    const taken = { kind: "CONFLICT", messageKey: "errors.boxGroup.nameTaken" };
    await expect(
      createBoxGroup(db, admin, { idempotencyKey: key(), name: " mailers " }),
    ).rejects.toMatchObject(taken);
    await expect(
      renameBoxGroup(db, admin, { id: cartons.id, name: "MAILERS" }),
    ).rejects.toMatchObject(taken);
    // A group may change the case of its own name.
    await expect(
      renameBoxGroup(db, admin, { id: cartons.id, name: "CARTONS" }),
    ).resolves.toMatchObject({ name: "CARTONS" });
  });

  it("refuses a case-insensitive duplicate in the database too", async () => {
    await db.boxGroup.create({ data: { name: "Mailers", position: 1 } });
    await expect(db.boxGroup.create({ data: { name: "MAILERS", position: 2 } })).rejects.toThrow();
  });

  it("renames with a before/after audit", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const group = await createBoxGroup(db, admin, { idempotencyKey: key(), name: "Mailers" });
    const renamed = await renameBoxGroup(db, admin, { id: group.id, name: "Poly mailers" });
    expect(renamed.name).toBe("Poly mailers");
    const events = await auditFor(group.id);
    expect(events.map((e) => e.action)).toEqual(["create", "rename"]);
    expect(events[1]?.before).toMatchObject({ name: "Mailers" });
    expect(events[1]?.after).toMatchObject({ name: "Poly mailers" });
  });

  it("moves a group by swapping with its neighbour; the ends are no-ops", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const names = ["Mailers", "Cartons", "Pails"];
    const [a, b, c] = await (async () => {
      const out = [];
      for (const name of names)
        out.push(await createBoxGroup(db, admin, { idempotencyKey: key(), name }));
      return out as [(typeof out)[0], (typeof out)[0], (typeof out)[0]];
    })();
    const order = (list: { name: string }[]) => list.map((g) => g.name);

    expect(order(await moveBoxGroup(db, admin, { id: c.id, direction: "up" }))).toEqual([
      "Mailers",
      "Pails",
      "Cartons",
    ]);
    expect(order(await moveBoxGroup(db, admin, { id: a.id, direction: "down" }))).toEqual([
      "Pails",
      "Mailers",
      "Cartons",
    ]);
    // The ends: unchanged and not audited.
    expect(order(await moveBoxGroup(db, admin, { id: c.id, direction: "up" }))).toEqual([
      "Pails",
      "Mailers",
      "Cartons",
    ]);
    expect(order(await moveBoxGroup(db, admin, { id: b.id, direction: "down" }))).toEqual([
      "Pails",
      "Mailers",
      "Cartons",
    ]);
    expect((await auditFor(c.id)).map((e) => e.action)).toEqual(["create", "move"]);
    expect((await auditFor(b.id)).map((e) => e.action)).toEqual(["create"]);
  });

  it("deletes a group, ungrouping its boxes (archived too) and deleting none", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const group = await createBoxGroup(db, admin, { idempotencyKey: key(), name: "Cartons" });
    const other = await createBoxGroup(db, admin, { idempotencyKey: key(), name: "Mailers" });
    const small = await createBox(db, admin, boxInput("Small", group.id));
    const old = await createBox(db, admin, boxInput("Old", group.id));
    await archiveBox(db, admin, { id: old.id });
    const mailer = await createBox(db, admin, boxInput("Mailer", other.id));

    await expect(deleteBoxGroup(db, admin, { id: group.id })).resolves.toEqual({ id: group.id });

    expect(await db.box.count()).toBe(3);
    const byId = Object.fromEntries((await db.box.findMany()).map((b) => [b.id, b.groupId]));
    expect(byId).toEqual({ [small.id]: null, [old.id]: null, [mailer.id]: other.id });
    const events = await auditFor(group.id);
    expect(events.map((e) => e.action)).toEqual(["create", "delete"]);
    expect(events[1]?.before).toMatchObject({
      name: "Cartons",
      ungroupedBoxes: ["Old", "Small"],
    });
  });

  it("is not found for an unknown id", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const id = "019a0000-0000-7000-8000-000000000000";
    await expect(renameBoxGroup(db, admin, { id, name: "X" })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    await expect(moveBoxGroup(db, admin, { id, direction: "up" })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    await expect(deleteBoxGroup(db, admin, { id })).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});

describe("box group permissions (criterion 33)", () => {
  it("lets anyone with box.read list, and only box.manage write", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const packer = await createActor(db, ["PACKER"]);
    const group = await createBoxGroup(db, admin, { idempotencyKey: key(), name: "Mailers" });

    await expect(listBoxGroups(db, packer)).resolves.toHaveLength(1);
    const forbidden = "errors.forbidden";
    await expect(
      createBoxGroup(db, packer, { idempotencyKey: key(), name: "Cartons" }),
    ).rejects.toThrowError(forbidden);
    await expect(renameBoxGroup(db, packer, { id: group.id, name: "X" })).rejects.toThrowError(
      forbidden,
    );
    await expect(moveBoxGroup(db, packer, { id: group.id, direction: "up" })).rejects.toThrowError(
      forbidden,
    );
    await expect(deleteBoxGroup(db, packer, { id: group.id })).rejects.toThrowError(forbidden);
    expect(await db.boxGroup.count()).toBe(1);
  });
});
