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
    });
    await updatePreferences(db, actor, { theme: "HIGH_CONTRAST", sidebarCollapsed: true });

    // A fresh read, as a new session on another device would do.
    expect(await getPreferences(db, actor)).toEqual({
      locale: "es",
      theme: "HIGH_CONTRAST",
      sidebarCollapsed: true,
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
