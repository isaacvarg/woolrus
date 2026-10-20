import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { JOBS_SCHEMA, queues } from "../jobs";
import {
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from "./invitations";
import { acceptInvitation, mayCreateAccount } from "./sign-in";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const appUrl = "https://woolrus.example";
const day = 86_400_000;
const nonAdmins: Role[] = ["PICKER", "PACKER", "QA", "SHIPPER"];
let keyCounter = 0;
const key = () => `invite-key-${++keyCounter}-${crypto.randomUUID()}`;

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

const unique = (name: string) => `${name}-${crypto.randomUUID()}@example.test`;

async function admin() {
  const actor = await createActor(db, ["ADMIN"]);
  await db.user.update({ where: { id: actor.userId }, data: { name: "Isa Admin" } });
  return actor;
}

describe("createInvitation", () => {
  it("invites a lowercased email with roles for 7 days, audits, and enqueues one English email", async () => {
    const actor = await admin();
    const email = unique("ana");
    const before = Date.now();

    const invitation = await createInvitation(
      db,
      actor,
      { idempotencyKey: key(), email: email.toUpperCase(), roles: ["PICKER", "PACKER"] },
      { appUrl },
    );

    expect(invitation).toMatchObject({
      email,
      roles: ["PICKER", "PACKER"],
      status: "pending",
      invitedByName: "Isa Admin",
    });
    expect(invitation.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * day);
    expect(invitation.expiresAt.getTime()).toBeLessThan(Date.now() + 7 * day + 1000);

    const jobs = await emailJobs(email);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({
      template: "invitation",
      locale: "en",
      params: { inviter: "Isa Admin", url: `${appUrl}/sign-in?email=${encodeURIComponent(email)}` },
    });

    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: invitation.id } });
    expect(audit).toMatchObject({ entityType: "Invitation", action: "invitation.create" });
  });

  it("is idempotent: a replayed key returns the same invitation and sends no second email", async () => {
    const actor = await admin();
    const email = unique("ben");
    const input = { idempotencyKey: key(), email, roles: ["QA" as const] };

    const first = await createInvitation(db, actor, input, { appUrl });
    const replay = await createInvitation(db, actor, input, { appUrl });

    expect(replay).toEqual(first);
    expect(await emailJobs(email)).toHaveLength(1);
  });

  it("refuses an email that already has an account", async () => {
    const actor = await admin();
    const existing = await createActor(db, ["PICKER"]);
    const { email } = await db.user.findUniqueOrThrow({ where: { id: existing.userId } });

    await expect(
      createInvitation(db, actor, { idempotencyKey: key(), email, roles: ["QA"] }, { appUrl }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.users.alreadyExists" });
    expect(await emailJobs(email)).toHaveLength(0);
  });

  it("refuses an email with a pending invitation", async () => {
    const actor = await admin();
    const email = unique("cy");
    await createInvitation(db, actor, { idempotencyKey: key(), email, roles: ["QA"] }, { appUrl });
    await expect(
      createInvitation(db, actor, { idempotencyKey: key(), email, roles: ["QA"] }, { appUrl }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.invitations.pending" });
  });

  it("reuses and resets the row of a revoked or expired invitation", async () => {
    const actor = await admin();
    const other = await admin();
    for (const ended of ["revoked", "expired"] as const) {
      const email = unique(ended);
      const old = await createInvitation(
        db,
        other,
        { idempotencyKey: key(), email, roles: ["QA"] },
        { appUrl },
      );
      await db.invitation.update({
        where: { id: old.id },
        data:
          ended === "revoked"
            ? { revokedAt: new Date() }
            : { expiresAt: new Date(Date.now() - day) },
      });

      const again = await createInvitation(
        db,
        actor,
        { idempotencyKey: key(), email, roles: ["SHIPPER"] },
        { appUrl },
      );
      expect(again).toMatchObject({ id: old.id, roles: ["SHIPPER"], status: "pending" });
      const row = await db.invitation.findUniqueOrThrow({ where: { id: old.id } });
      expect(row).toMatchObject({ invitedById: actor.userId, revokedAt: null, acceptedAt: null });
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * day);
      expect(await emailJobs(email)).toHaveLength(2);
    }
  });

  it("rolls the email job back with the invitation", async () => {
    const actor = await admin();
    const email = unique("rollback");
    // Fail the audit insert, which runs after the job is enqueued in the same transaction.
    await db.$executeRawUnsafe(`
      CREATE FUNCTION fail_invitation_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'audit failed'; END $$`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER fail_invitation_audit BEFORE INSERT ON audit_events FOR EACH ROW
      WHEN (NEW.after->>'email' = '${email}') EXECUTE FUNCTION fail_invitation_audit()`);
    try {
      await expect(
        createInvitation(db, actor, { idempotencyKey: key(), email, roles: ["QA"] }, { appUrl }),
      ).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER fail_invitation_audit ON audit_events");
      await db.$executeRawUnsafe("DROP FUNCTION fail_invitation_audit");
    }
    expect(await db.invitation.count({ where: { email } })).toBe(0);
    expect(await emailJobs(email)).toHaveLength(0);
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    const actor = await createActor(db, [role]);
    await expect(
      createInvitation(
        db,
        actor,
        { idempotencyKey: key(), email: unique("x"), roles: ["QA"] },
        { appUrl },
      ),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("listInvitations", () => {
  it("derives each invitation's status", async () => {
    const actor = await admin();
    const make = async (name: string) =>
      createInvitation(
        db,
        actor,
        { idempotencyKey: key(), email: unique(name), roles: ["QA"] },
        { appUrl },
      );
    const pending = await make("pending");
    const expired = await make("expired");
    const accepted = await make("accepted");
    const revoked = await make("revoked");
    await db.invitation.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await db.invitation.update({ where: { id: accepted.id }, data: { acceptedAt: new Date() } });
    await db.invitation.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });

    const statuses = Object.fromEntries(
      (await listInvitations(db, actor)).map((i) => [i.id, i.status]),
    );
    expect(statuses).toEqual({
      [pending.id]: "pending",
      [expired.id]: "expired",
      [accepted.id]: "accepted",
      [revoked.id]: "revoked",
    });
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    await expect(listInvitations(db, await createActor(db, [role]))).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});

describe("resendInvitation", () => {
  it("extends an expired invitation by 7 days and sends another email", async () => {
    const actor = await admin();
    const email = unique("resend");
    const invitation = await createInvitation(
      db,
      actor,
      { idempotencyKey: key(), email, roles: ["QA"] },
      { appUrl },
    );
    await db.invitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - day) },
    });

    const resent = await resendInvitation(db, actor, { id: invitation.id }, { appUrl });
    expect(resent.status).toBe("pending");
    expect(resent.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * day);
    expect(await emailJobs(email)).toHaveLength(2);
    expect(
      await db.auditEvent.count({
        where: { entityId: invitation.id, action: "invitation.resend" },
      }),
    ).toBe(1);
  });

  it("refuses an accepted or revoked invitation", async () => {
    const actor = await admin();
    const invitation = await createInvitation(
      db,
      actor,
      { idempotencyKey: key(), email: unique("closed"), roles: ["QA"] },
      { appUrl },
    );
    await revokeInvitation(db, actor, { id: invitation.id });
    await expect(
      resendInvitation(db, actor, { id: invitation.id }, { appUrl }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.invitations.notOpen" });
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    await expect(
      resendInvitation(db, await createActor(db, [role]), { id: crypto.randomUUID() }, { appUrl }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("revokeInvitation", () => {
  it("revokes, audits, and is idempotent", async () => {
    const actor = await admin();
    const invitation = await createInvitation(
      db,
      actor,
      { idempotencyKey: key(), email: unique("revoke"), roles: ["QA"] },
      { appUrl },
    );
    expect((await revokeInvitation(db, actor, { id: invitation.id })).status).toBe("revoked");
    expect((await revokeInvitation(db, actor, { id: invitation.id })).status).toBe("revoked");
    expect(
      await db.auditEvent.count({
        where: { entityId: invitation.id, action: "invitation.revoke" },
      }),
    ).toBe(1);
  });

  it("refuses an accepted invitation", async () => {
    const actor = await admin();
    const invitation = await createInvitation(
      db,
      actor,
      { idempotencyKey: key(), email: unique("taken"), roles: ["QA"] },
      { appUrl },
    );
    await db.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
    await expect(revokeInvitation(db, actor, { id: invitation.id })).rejects.toMatchObject({
      messageKey: "errors.invitations.notOpen",
    });
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    await expect(
      revokeInvitation(db, await createActor(db, [role]), { id: crypto.randomUUID() }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("accepting an invitation (sign-up)", () => {
  const adminEmails = ["boss@example.test"];

  async function invite(roles: Role[]) {
    const actor = await admin();
    const email = unique("new");
    const invitation = await createInvitation(
      db,
      actor,
      { idempotencyKey: key(), email, roles },
      { appUrl },
    );
    return { email, invitation };
  }

  async function signUp(email: string) {
    return db.user.create({ data: { name: "New", email, roles: [] } });
  }

  it("gives exactly the invited roles and marks the invitation accepted", async () => {
    const { email, invitation } = await invite(["PICKER", "PACKER"]);
    expect(
      await mayCreateAccount(db, { email: email.toUpperCase(), emailVerified: true }, adminEmails),
    ).toBe(true);

    const user = await signUp(email);
    await acceptInvitation(db, { id: user.id, email }, adminEmails);

    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).roles).toEqual([
      "PICKER",
      "PACKER",
    ]);
    expect(
      (await listInvitations(db, await admin())).find((i) => i.id === invitation.id)?.status,
    ).toBe("accepted");
  });

  it("refuses a revoked or expired invitation, and an email never invited", async () => {
    const revoked = await invite(["QA"]);
    await db.invitation.update({
      where: { id: revoked.invitation.id },
      data: { revokedAt: new Date() },
    });
    const expired = await invite(["QA"]);
    await db.invitation.update({
      where: { id: expired.invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(
      await mayCreateAccount(db, { email: revoked.email, emailVerified: true }, adminEmails),
    ).toBe(false);
    expect(
      await mayCreateAccount(db, { email: expired.email, emailVerified: true }, adminEmails),
    ).toBe(false);
    expect(
      await mayCreateAccount(db, { email: unique("stranger"), emailVerified: true }, adminEmails),
    ).toBe(false);
  });

  it("lets an ADMIN_EMAILS address in as Admin without an invitation", async () => {
    expect(
      await mayCreateAccount(db, { email: "Boss@Example.test", emailVerified: true }, adminEmails),
    ).toBe(true);
    const user = await signUp("boss@example.test");
    await acceptInvitation(db, { id: user.id, email: "boss@example.test" }, adminEmails);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).roles).toEqual(["ADMIN"]);
  });
});
