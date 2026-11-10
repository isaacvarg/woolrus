import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { EmailMessage } from "../adapters/email/sender";
import { JOBS_SCHEMA, queues } from "../jobs";
import { createInvitation, revokeInvitation } from "./invitations";
import { mayStartSession, sendMagicLink } from "./sign-in";
import { addUserEmail, createStationUser, updateUserRoles } from "./users";

// SPEC-identity amendment 1, success criterion 21: an admin adds an email to a station-only user,
// who then becomes a regular user with the same id, roles, PIN, badge and history.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const appUrl = "https://woolrus.example";
const nonAdmins: Role[] = ["PICKER", "PACKER", "QA", "SHIPPER"];
const unique = (name: string) => `${name}-${crypto.randomUUID()}@example.test`;
const key = () => crypto.randomUUID();

/** email.send jobs addressed to `to` (pg-boss's tables aren't reset between tests). */
async function emailJobs(to: string) {
  return db.$queryRawUnsafe<
    { data: { template: string; params: Record<string, string>; locale: string } }[]
  >(
    `SELECT data FROM ${JOBS_SCHEMA}.job WHERE name = $1 AND data->>'to' = $2 ORDER BY created_on`,
    queues.emailSend,
    to,
  );
}

async function admin() {
  const actor = await createActor(db, ["ADMIN"]);
  await db.user.update({ where: { id: actor.userId }, data: { name: "Isa Admin" } });
  return actor;
}

async function stationUser(actor: Awaited<ReturnType<typeof admin>>) {
  return createStationUser(db, actor, {
    name: "Luis",
    roles: ["PICKER"],
    pin: "482916",
    idempotencyKey: key(),
  });
}

describe("addUserEmail", () => {
  it("replaces the placeholder, keeps the user, and makes them a regular user", async () => {
    const actor = await admin();
    const created = await stationUser(actor);
    const before = await db.user.findUniqueOrThrow({ where: { id: created.id } });
    const email = unique("Luis").toUpperCase();

    const updated = await addUserEmail(
      db,
      actor,
      { id: created.id, email, idempotencyKey: key() },
      { appUrl },
    );

    expect(updated).toMatchObject({
      id: created.id,
      email: email.toLowerCase(),
      stationOnly: false,
      roles: ["PICKER"],
      hasPin: true,
    });
    const row = await db.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({
      email: email.toLowerCase(),
      emailVerified: true,
      pinHash: before.pinHash,
      name: "Luis",
    });
    expect(
      await db.auditEvent.findFirst({ where: { entityId: created.id, action: "user.email.add" } }),
    ).toMatchObject({ actorId: actor.userId, after: { email: email.toLowerCase() } });
    // Now a regular user: Admin can be given.
    await expect(
      updateUserRoles(db, actor, { id: created.id, roles: ["PICKER", "ADMIN"] }),
    ).resolves.toMatchObject({ roles: ["PICKER", "ADMIN"], stationOnly: false });
  });

  it("enqueues exactly one accountEnabled email, in English, linking to sign-in", async () => {
    const actor = await admin();
    const created = await stationUser(actor);
    const email = unique("luis");

    await addUserEmail(db, actor, { id: created.id, email, idempotencyKey: key() }, { appUrl });

    const jobs = await emailJobs(email);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({
      template: "accountEnabled",
      locale: "en",
      params: {
        admin: "Isa Admin",
        url: `${appUrl}/sign-in?email=${encodeURIComponent(email)}`,
      },
    });
  });

  it("is idempotent: a replay returns the same user and sends no second email", async () => {
    const actor = await admin();
    const created = await stationUser(actor);
    const email = unique("replay");
    const input = { id: created.id, email, idempotencyKey: key() };

    const first = await addUserEmail(db, actor, input, { appUrl });
    const second = await addUserEmail(db, actor, input, { appUrl });

    expect(second).toEqual(first);
    expect(await emailJobs(email)).toHaveLength(1);
  });

  it("rolls the email job back with the change", async () => {
    const actor = await admin();
    const created = await stationUser(actor);
    const email = unique("rollback");
    // Fail the audit insert, which runs after the job is enqueued in the same transaction.
    await db.$executeRawUnsafe(`
      CREATE FUNCTION fail_email_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'audit failed'; END $$`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER fail_email_audit BEFORE INSERT ON audit_events FOR EACH ROW
      WHEN (NEW.after->>'email' = '${email}') EXECUTE FUNCTION fail_email_audit()`);
    try {
      await expect(
        addUserEmail(db, actor, { id: created.id, email, idempotencyKey: key() }, { appUrl }),
      ).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER fail_email_audit ON audit_events");
      await db.$executeRawUnsafe("DROP FUNCTION fail_email_audit");
    }
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect(await emailJobs(email)).toHaveLength(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: created.id } })).email).toMatch(
      /@station\.invalid$/,
    );
  });

  it("then lets a magic link to the new address sign in the same user", async () => {
    const actor = await admin();
    const created = await stationUser(actor);
    const email = unique("signin");
    await addUserEmail(db, actor, { id: created.id, email, idempotencyKey: key() }, { appUrl });

    const sent: EmailMessage[] = [];
    const result = await sendMagicLink(
      db,
      { email, url: "https://woolrus.example/verify", fallbackLocale: "en" },
      {
        adminEmails: [],
        sender: async () => ({ kind: "resend", send: async (m) => void sent.push(m) }),
        log: { info: () => {}, error: () => {} },
      },
    );
    expect(result).toBe("sent");
    expect(sent.map((m) => m.to)).toEqual([email]);
    // Better Auth finds the user by this email, so the session it creates is for the same id.
    expect((await db.user.findFirstOrThrow({ where: { email } })).id).toBe(created.id);
    expect(await mayStartSession(db, created.id)).toEqual({ allowed: true });
  });

  it("refuses a regular user", async () => {
    const actor = await admin();
    const regular = await createActor(db, ["PICKER"]);
    await expect(
      addUserEmail(
        db,
        actor,
        { id: regular.userId, email: unique("x"), idempotencyKey: key() },
        { appUrl },
      ),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.users.notStationOnly" });
  });

  it("refuses a deactivated station-only user, with no email sent", async () => {
    const actor = await admin();
    const created = await stationUser(actor);
    await db.user.update({ where: { id: created.id }, data: { active: false } });
    const email = unique("gone");
    await expect(
      addUserEmail(db, actor, { id: created.id, email, idempotencyKey: key() }, { appUrl }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.users.addEmailInactive" });
    expect(await emailJobs(email)).toHaveLength(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: created.id } })).email).not.toBe(email);
  });

  it("refuses an address another user has, in any case", async () => {
    const actor = await admin();
    const created = await stationUser(actor);
    const other = await createActor(db, ["PACKER"]);
    const { email } = await db.user.findUniqueOrThrow({ where: { id: other.userId } });
    await expect(
      addUserEmail(
        db,
        actor,
        { id: created.id, email: email.toUpperCase(), idempotencyKey: key() },
        { appUrl },
      ),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.users.alreadyExists" });
  });

  it("refuses an address with an open invitation, until it's revoked", async () => {
    const actor = await admin();
    const created = await stationUser(actor);
    const email = unique("invited");
    const invitation = await createInvitation(
      db,
      actor,
      { email, roles: ["QA"], idempotencyKey: key() },
      { appUrl },
    );
    await expect(
      addUserEmail(db, actor, { id: created.id, email, idempotencyKey: key() }, { appUrl }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.users.invitationPending" });

    await revokeInvitation(db, actor, { id: invitation.id });
    await expect(
      addUserEmail(db, actor, { id: created.id, email, idempotencyKey: key() }, { appUrl }),
    ).resolves.toMatchObject({ email, stationOnly: false });
  });

  it("refuses the reserved station-only domain", async () => {
    const actor = await admin();
    const created = await stationUser(actor);
    await expect(
      addUserEmail(
        db,
        actor,
        { id: created.id, email: "luis@STATION.invalid", idempotencyKey: key() },
        { appUrl },
      ),
    ).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      messageKey: "errors.invitations.reservedEmail",
    });
  });

  it("returns NOT_FOUND for an unknown user", async () => {
    const actor = await admin();
    await expect(
      addUserEmail(
        db,
        actor,
        { id: crypto.randomUUID(), email: unique("x"), idempotencyKey: key() },
        { appUrl },
      ),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    const created = await stationUser(await admin());
    const actor = await createActor(db, [role]);
    const email = unique("forbidden");
    await expect(
      addUserEmail(db, actor, { id: created.id, email, idempotencyKey: key() }, { appUrl }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(await db.user.count({ where: { email } })).toBe(0);
  });
});
