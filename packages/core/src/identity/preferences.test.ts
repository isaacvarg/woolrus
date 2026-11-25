import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { getPreferences, updatePreferences } from "./preferences";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

describe("updatePreferences", () => {
  it("changes only the fields given and keeps them on the user", async () => {
    const actor = await createActor(db, ["PICKER"]);

    expect(await updatePreferences(db, actor, { locale: "es" })).toEqual({
      locale: "es",
      theme: "SYSTEM",
      sidebarCollapsed: false,
      boxPickerColumns: 1,
    });
    await updatePreferences(db, actor, { theme: "HIGH_CONTRAST", sidebarCollapsed: true });

    // A fresh read, as a new session on another device would do.
    expect(await getPreferences(db, actor)).toEqual({
      locale: "es",
      theme: "HIGH_CONTRAST",
      sidebarCollapsed: true,
      boxPickerColumns: 1,
    });
  });

  it("works for every role, and only changes the actor's own user", async () => {
    const other = await createActor(db, ["ADMIN"]);
    for (const role of ["ADMIN", "PICKER", "PACKER", "QA", "SHIPPER"] as const) {
      const actor = await createActor(db, [role]);
      await expect(updatePreferences(db, actor, { theme: "DARK" })).resolves.toMatchObject({
        theme: "DARK",
      });
    }
    expect((await getPreferences(db, other)).theme).toBe("SYSTEM");
  });
});

describe("boxPickerColumns (SPEC-packing A2, criterion 32)", () => {
  it("defaults to 1, saves 2 for the actor only, and reads back on a fresh read", async () => {
    const other = await createActor(db, ["PACKER"]);
    const actor = await createActor(db, ["PACKER"]);
    expect((await getPreferences(db, actor)).boxPickerColumns).toBe(1);

    await expect(updatePreferences(db, actor, { boxPickerColumns: 2 })).resolves.toMatchObject({
      boxPickerColumns: 2,
    });
    expect((await getPreferences(db, actor)).boxPickerColumns).toBe(2);
    expect((await getPreferences(db, other)).boxPickerColumns).toBe(1);
  });

  it("is refused by the database CHECK when it isn't 1 or 2", async () => {
    const actor = await createActor(db, ["PACKER"]);
    for (const value of [0, 3]) {
      await expect(
        db.user.update({ where: { id: actor.userId }, data: { boxPickerColumns: value } }),
      ).rejects.toThrow(/users_box_picker_columns_check/);
    }
    expect((await getPreferences(db, actor)).boxPickerColumns).toBe(1);
  });
});
