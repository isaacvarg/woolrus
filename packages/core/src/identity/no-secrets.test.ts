import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { EmailSender } from "../adapters/email/sender";
import { getPublicSettings, getSettings, setSecret } from "../settings/service";
import { sendTestEmail } from "./email";
import { createInvitation, listInvitations } from "./invitations";
import {
  findStationByToken,
  listStations,
  lockStation,
  registerStation,
  stationActor,
  stationStatus,
  touchStation,
  unlockWithBadge,
  unlockWithPin,
} from "./stations";
import { issueBadge, listUsers, setPin } from "./users";

// SPEC-identity success criterion 9: one session that sets a PIN, issues a badge, registers a
// station and sets the Resend key. Every response and audit row is serialized and searched; none
// may hold a PIN, PIN hash, badge hash, station token (or its hash) or the Resend key (or its
// ciphertext). The badge code may appear in the issueBadge response only: it's printed from there.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => {
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  return resetDb(db);
});
afterEach(() => vi.unstubAllEnvs());

const PIN = "482916";
const RESEND_KEY = "re_sweep_0123456789abcdefghijklmnop";

/** Which of `secrets` (by name) appear anywhere in `value`'s JSON. */
function leaks(value: unknown, secrets: Record<string, string>): string[] {
  const json = JSON.stringify(value) ?? "";
  return Object.entries(secrets)
    .filter(([, secret]) => json.includes(secret))
    .map(([name]) => name);
}

describe("no secrets out", () => {
  it("the scanner finds a planted secret, so a clean result means something", () => {
    expect(leaks({ nested: [{ pin: PIN }] }, { pin: PIN })).toEqual(["pin"]);
  });

  it("no response or audit row holds a credential; the badge code only in issueBadge", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const worker = await createActor(db, ["PACKER"]);
    const sent: unknown[] = [];
    const fakeSender: EmailSender = {
      kind: "resend",
      send: async (message) => {
        sent.push(message);
      },
    };
    const responses: Record<string, unknown> = {};

    // The admin's session.
    responses.setPin = await setPin(db, admin, { id: worker.userId, pin: PIN });
    const badge = await issueBadge(db, admin, { id: worker.userId });
    const { station: registered, token } = await registerStation(db, admin, { name: "Pack 2" });
    responses.register = registered; // The route sends this; the token goes only in the cookie.
    responses.setSecret = await setSecret(db, admin, { name: "resendApiKey", value: RESEND_KEY });
    responses.getSettings = await getSettings(db, admin);
    responses.publicSettings = await getPublicSettings(db, admin);
    responses.testEmail = await sendTestEmail(db, admin, async () => fakeSender);
    responses.invite = await createInvitation(
      db,
      admin,
      { email: "new@example.test", roles: ["PICKER"], idempotencyKey: crypto.randomUUID() },
      { appUrl: "http://localhost:3000" },
    );
    responses.invitations = await listInvitations(db, admin);
    responses.users = await listUsers(db, admin);
    responses.stations = await listStations(db, admin);

    // The floor: the station device, then the worker on it.
    const station = (await findStationByToken(db, token)) ?? fail();
    responses.status = await stationStatus(db, station);
    responses.unlockPin = await unlockWithPin(db, station, { userId: worker.userId, pin: PIN });
    responses.unlockBadge = await unlockWithBadge(db, station, { code: badge.code });
    const actor = (await stationActor(db, station))?.actor ?? fail();
    responses.touch = await touchStation(db, actor);
    responses.lock = await lockStation(db, actor);
    responses.stationsAfter = await listStations(db, admin);

    const userRow = await db.user.findUniqueOrThrow({ where: { id: worker.userId } });
    const stationRow = await db.station.findUniqueOrThrow({ where: { id: station.id } });
    const settingsRow = await db.settings.findFirstOrThrow();
    const secrets = {
      pin: PIN,
      pinHash: userRow.pinHash ?? fail(),
      badgeHash: userRow.badgeCode ?? fail(),
      stationToken: token,
      stationTokenHash: stationRow.tokenHash,
      resendKey: RESEND_KEY,
      resendKeyCiphertext: settingsRow.resendApiKeyEnc ?? fail(),
    };

    const audit = await db.auditEvent.findMany();
    expect(audit.length).toBeGreaterThan(5);
    expect(leaks(audit, { ...secrets, badgeCode: badge.code })).toEqual([]);
    for (const [name, response] of Object.entries(responses)) {
      expect({ name, leaks: leaks(response, { ...secrets, badgeCode: badge.code }) }).toEqual({
        name,
        leaks: [],
      });
    }
    expect(leaks(badge, secrets)).toEqual([]);
    expect(JSON.stringify(badge)).toContain(badge.code);
    expect(leaks(sent, secrets)).toEqual([]);
  });
});

function fail(): never {
  throw new Error("expected a value");
}
