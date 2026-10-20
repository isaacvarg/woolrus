import { randomBytes } from "node:crypto";
import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { EmailError, type EmailMessage, type EmailSender } from "../adapters/email/sender";
import { enqueue } from "../enqueue";
import { type JobPayloads, queues } from "../jobs";
import { setSecret, updateSettings } from "../settings/service";
import { emailStatus, getEmailSender, runEmailJob, sendTestEmail } from "./email";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});
afterEach(() => vi.unstubAllEnvs());

const RESEND_KEY = "re_live_secret_value_123";
const nonAdmins = [["PICKER"], ["PACKER"], ["QA"], ["SHIPPER"]] as const;

/** A sender that records what it was given, or fails with `error`. */
function fakeSender(error?: Error) {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    kind: "resend",
    async send(message) {
      if (error) throw error;
      sent.push(message);
    },
  };
  return { sender, sent };
}

async function configureResend() {
  const admin = await createActor(db, ["ADMIN"]);
  await updateSettings(db, admin, { emailFrom: "Woolrus <no-reply@example.com>" });
  await setSecret(db, admin, { name: "resendApiKey", value: RESEND_KEY });
  return admin;
}

describe("getEmailSender and emailStatus", () => {
  it("logs instead of sending until Resend is configured", async () => {
    const logged: unknown[] = [];
    const sender = await getEmailSender(db, { log: (entry) => logged.push(entry) });
    expect(sender.kind).toBe("log");
    expect(await emailStatus(db)).toBe("unconfigured");

    await sender.send({
      to: "ana@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi http://localhost:3000/link",
      idempotencyKey: "k",
    });
    expect(logged).toEqual([
      { to: "ana@example.com", subject: "Hi", text: "Hi http://localhost:3000/link" },
    ]);
  });

  it("leaves the body out of the log in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const logged: unknown[] = [];
    const sender = await getEmailSender(db, { log: (entry) => logged.push(entry) });
    await sender.send({
      to: "a@example.com",
      subject: "Hi",
      html: "",
      text: "x",
      idempotencyKey: "k",
    });
    expect(logged).toEqual([{ to: "a@example.com", subject: "Hi" }]);
  });

  it("uses Resend once the sender and key are both set", async () => {
    await configureResend();
    expect((await getEmailSender(db, { log: () => {} })).kind).toBe("resend");
    expect(await emailStatus(db)).toBe("ok");
  });
});

describe("sendTestEmail", () => {
  it("sends the test email to the admin's own address, in their language", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await db.user.update({ where: { id: admin.userId }, data: { locale: "es" } });
    const { email } = await db.user.findUniqueOrThrow({ where: { id: admin.userId } });
    const { sender, sent } = fakeSender();

    expect(await sendTestEmail(db, admin, async () => sender)).toEqual({
      ok: true,
      to: email,
      via: "resend",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: email, subject: "Correo de prueba de Woolrus" });
    expect(sent[0]?.text).toContain("Woolrus");
    expect(sent[0]?.html).toContain("<p>");
  });

  it("uses a new idempotency key each time, so every press sends", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const { sender, sent } = fakeSender();
    await sendTestEmail(db, admin, async () => sender);
    await sendTestEmail(db, admin, async () => sender);
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(2);
  });

  it("says when it was only logged", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const result = await sendTestEmail(db, admin, (db) => getEmailSender(db, { log: () => {} }));
    expect(result).toMatchObject({ ok: true, via: "log" });
  });

  it.each([
    ["unauthorized", new EmailError("unauthorized", "403 invalid_api_key", 403)],
    ["unavailable", new EmailError("unavailable", "network")],
  ])("turns a %s failure into its message key", async (kind, error) => {
    const admin = await createActor(db, ["ADMIN"]);
    expect(await sendTestEmail(db, admin, async () => fakeSender(error).sender)).toEqual({
      ok: false,
      messageKey: `errors.email.${kind}`,
    });
  });

  it.each(nonAdmins)("is forbidden for %s", async (role) => {
    const actor = await createActor(db, [role]);
    const { sender, sent } = fakeSender();
    await expect(sendTestEmail(db, actor, async () => sender)).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect(sent).toHaveLength(0);
  });

  it("never puts the Resend key in a response or an audit row", async () => {
    const admin = await configureResend();
    const result = await sendTestEmail(db, admin, async () => fakeSender().sender);
    const failed = await sendTestEmail(
      db,
      admin,
      async () => fakeSender(new EmailError("rejected", "422 validation_error", 422)).sender,
    );
    const audit = await db.auditEvent.findMany();
    expect(JSON.stringify({ result, failed, audit })).not.toContain(RESEND_KEY);
  });
});

describe("email.send job", () => {
  const payload: JobPayloads[typeof queues.emailSend] = {
    to: "ana@example.com",
    template: "test",
    params: {},
    locale: "en",
    idempotencyKey: "job-key-1",
  };

  it("renders the template and sends it with the job's idempotency key", async () => {
    const { sender, sent } = fakeSender();
    expect(await runEmailJob(sender, payload, { log: () => {} })).toBe("sent");
    expect(sent).toEqual([
      expect.objectContaining({
        to: "ana@example.com",
        subject: "Woolrus test email",
        idempotencyKey: "job-key-1",
      }),
    ]);
  });

  it("logs a permanent failure and finishes, so pg-boss doesn't retry it", async () => {
    const logged: unknown[] = [];
    const { sender } = fakeSender(new EmailError("rejected", "422 validation_error", 422));
    expect(await runEmailJob(sender, payload, { log: (e) => logged.push(e) })).toBe("rejected");
    expect(logged).toEqual([
      { template: "test", idempotencyKey: "job-key-1", error: "rejected: 422 validation_error" },
    ]);
  });

  it.each([
    ["a retryable failure", new EmailError("unavailable", "500 application_error", 500)],
    ["an unexpected error", new Error("boom")],
  ])("throws %s so pg-boss retries", async (_, error) => {
    const { sender } = fakeSender(error);
    await expect(runEmailJob(sender, payload, { log: () => {} })).rejects.toBe(error);
  });

  async function jobsWithKey(key: string) {
    return db.$queryRaw<{ retry_limit: number; retry_backoff: boolean }[]>`
      SELECT retry_limit, retry_backoff FROM pgboss.job
      WHERE name = ${queues.emailSend} AND data->>'idempotencyKey' = ${key}`;
  }

  it("is enqueued on the caller's transaction: 3 attempts with backoff, gone on rollback", async () => {
    const committed = crypto.randomUUID();
    await db.$transaction((tx) =>
      enqueue(tx, queues.emailSend, { ...payload, idempotencyKey: committed }),
    );
    expect(await jobsWithKey(committed)).toEqual([{ retry_limit: 2, retry_backoff: true }]);

    const rolledBack = crypto.randomUUID();
    await expect(
      db.$transaction(async (tx) => {
        await enqueue(tx, queues.emailSend, { ...payload, idempotencyKey: rolledBack });
        throw new Error("caller failed");
      }),
    ).rejects.toThrow("caller failed");
    expect(await jobsWithKey(rolledBack)).toEqual([]);
  });
});
