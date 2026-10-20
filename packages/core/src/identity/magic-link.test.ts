import type { Db } from "@woolrus/db";
import type { Locale } from "@woolrus/i18n";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { EmailMessage, EmailSender } from "../adapters/email/sender";
import { EmailError } from "../adapters/email/sender";
import { mayCreateAccount, sendMagicLink } from "./sign-in";

// SPEC-identity "Sign-in hardening": magic links only go to people who may sign in, so our email
// account can't be used to mail arbitrary addresses, and the response never says which is which.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const adminEmails = ["boss@example.test"];
const url = "https://woolrus.example/api/auth/magic-link/verify?token=secret";

function fakeSender(fail?: Error) {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    kind: "resend",
    async send(message) {
      if (fail) throw fail;
      sent.push(message);
    },
  };
  return { sent, sender };
}

function run(
  email: string,
  sender: EmailSender,
  logs: unknown[] = [],
  fallbackLocale: Locale = "en",
) {
  return sendMagicLink(
    db,
    { email, url, fallbackLocale },
    {
      adminEmails,
      sender: async () => sender,
      log: { info: (e) => logs.push(e), error: (e) => logs.push(e) },
    },
  );
}

async function userWith(data: { locale?: "en" | "es"; active?: boolean }) {
  const actor = await createActor(db, ["PICKER"]);
  return db.user.update({ where: { id: actor.userId }, data });
}

describe("sendMagicLink", () => {
  it("sends to an active user, in their language, with the link", async () => {
    const user = await userWith({ locale: "es" });
    const { sent, sender } = fakeSender();

    expect(await run(user.email.toUpperCase(), sender)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: user.email.toUpperCase(),
      subject: "Tu enlace para iniciar sesión en Woolrus",
    });
    expect(sent[0]?.text).toContain(url);
    expect(sent[0]?.html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
  });

  it("sends to an open invitation and an ADMIN_EMAILS address, in the page's language", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await db.invitation.create({
      data: {
        email: "invited@example.test",
        roles: ["QA"],
        invitedById: admin.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const { sent, sender } = fakeSender();

    expect(await run("invited@example.test", sender, [], "es")).toBe("sent");
    expect(await run("Boss@example.test", sender)).toBe("sent");
    expect(sent.map((m) => m.subject)).toEqual([
      "Tu enlace para iniciar sesión en Woolrus",
      "Your Woolrus sign-in link",
    ]);
  });

  it("sends nothing to a stranger, a deactivated user or a revoked invitation, and logs at info", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const inactive = await userWith({ active: false });
    await db.invitation.create({
      data: {
        email: "revoked@example.test",
        roles: ["QA"],
        invitedById: admin.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: new Date(),
      },
    });
    const { sent, sender } = fakeSender();
    const logs: unknown[] = [];

    for (const email of ["stranger@example.test", inactive.email, "revoked@example.test"]) {
      expect(await run(email, sender, logs)).toBe("skipped");
    }
    expect(sent).toHaveLength(0);
    expect(logs).toHaveLength(3);
    expect(JSON.stringify(logs)).not.toContain("token=secret");
  });

  it("doesn't reveal a send failure to the caller; it logs it", async () => {
    const user = await userWith({});
    const { sender } = fakeSender(new EmailError("unavailable", "503", 503));
    const logs: unknown[] = [];

    expect(await run(user.email, sender, logs)).toBe("failed");
    expect(JSON.stringify(logs)).not.toContain("token=secret");
  });
});

describe("mayCreateAccount (SRS §7.1 #3: any account got full access)", () => {
  it("refuses an email with no open invitation that isn't in ADMIN_EMAILS", async () => {
    expect(await mayCreateAccount(db, "nobody@example.test", adminEmails)).toBe(false);
  });
});
