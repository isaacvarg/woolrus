import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { verifyPin } from "./credentials";
import { unlockWithPin } from "./station-session";
import { findStationByToken, registerStation } from "./stations";

// A file of its own: the module mock below applies to every test in the file. It passes through
// to the real verifyPin and only records the calls.
vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  return { ...actual, verifyPin: vi.fn(actual.verifyPin) };
});

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  vi.mocked(verifyPin).mockClear();
  await resetDb(db);
});

describe("unlockWithPin without a PIN to check", () => {
  // A wrong PIN costs one scrypt; so must an unknown user, a user without a PIN or an inactive one,
  // or the response time would tell the tiles apart from real PIN holders.
  it("still runs one scrypt verify, against a decoy hash", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { token } = await registerStation(db, admin, { name: "Pack 2" });
    const station = await findStationByToken(db, token);
    if (!station) throw new Error("expected a station");
    const noPin = await createActor(db, ["PACKER"]);
    const gone = await createActor(db, ["PACKER"]);
    await db.user.update({ where: { id: gone.userId }, data: { active: false } });

    for (const userId of [crypto.randomUUID(), noPin.userId, gone.userId]) {
      vi.mocked(verifyPin).mockClear();
      await expect(unlockWithPin(db, station, { userId, pin: "482916" })).rejects.toMatchObject({
        messageKey: "errors.station.badPin",
      });
      expect(verifyPin).toHaveBeenCalledTimes(1);
      expect(vi.mocked(verifyPin).mock.calls[0]?.[1]).toMatch(/^scrypt\$/);
    }
  });
});
