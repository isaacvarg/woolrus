import type { Db } from "@woolrus/db";
import type { Locale } from "@woolrus/i18n";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { EmailMessage, EmailSender } from "../adapters/email/sender";
import { EmailError } from "../adapters/email/sender";
import { mayCreateAccount, mayStartSession, sendMagicLink } from "./sign-in";
import { stationOnlyPlaceholder } from "./station-only";

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
    expect(
      await mayCreateAccount(
        db,
        { email: "nobody@example.test", emailVerified: true },
        adminEmails,
      ),
    ).toBe(false);
  });

  // An OAuth provider (Discord) can hand over an address its user never verified. Better Auth
  // creates the account anyway, so an attacker could take an invitation or an ADMIN_EMAILS
  // bootstrap by naming the address. Magic-link sign-ups arrive verified.
  it("refuses an unverified email, even with an open invitation or in ADMIN_EMAILS", async () => {
    const [admin] = adminEmails;
    if (!admin) throw new Error("expected an admin email");
    await db.invitation.create({
      data: {
        email: "invited@example.test",
        roles: ["PACKER"],
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    for (const email of ["invited@example.test", admin]) {
      expect(await mayCreateAccount(db, { email, emailVerified: false }, adminEmails)).toBe(false);
      expect(await mayCreateAccount(db, { email, emailVerified: true }, adminEmails)).toBe(true);
    }
  });
});

// SPEC-identity amendment 1: a station-only user unlocks stations by PIN and never signs in
// personally, whatever the method (criterion 18).
describe("station-only users can't sign in personally", () => {
  async function stationOnlyUser(active = true) {
    const actor = await createActor(db, ["PICKER"]);
    return db.user.update({
      where: { id: actor.userId },
      data: { email: stationOnlyPlaceholder(), active },
    });
  }

  it("sendMagicLink sends nothing to a placeholder, the same silent path as a stranger", async () => {
    const user = await stationOnlyUser();
    const { sent, sender } = fakeSender();
    const logs: unknown[] = [];
    const strangerLogs: unknown[] = [];

    expect(await run(user.email.toUpperCase(), sender, logs)).toBe("skipped");
    expect(await run("stranger@example.test", sender, strangerLogs)).toBe("skipped");
    expect(sent).toHaveLength(0);
    expect(logs).toEqual([{ email: user.email }]);
    expect(strangerLogs).toEqual([{ email: "stranger@example.test" }]);
  });

  it("sendMagicLink sends nothing to a placeholder listed in ADMIN_EMAILS", async () => {
    const email = stationOnlyPlaceholder();
    const { sent, sender } = fakeSender();
    const result = await sendMagicLink(
      db,
      { email, url, fallbackLocale: "en" },
      {
        adminEmails: [email],
        sender: async () => sender,
        log: { info: () => {}, error: () => {} },
      },
    );

    expect(result).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("mayCreateAccount refuses a placeholder, even in ADMIN_EMAILS or with an open invitation", async () => {
    const email = stationOnlyPlaceholder();
    await db.invitation.create({
      data: { email, roles: ["PICKER"], expiresAt: new Date(Date.now() + 86_400_000) },
    });

    expect(await mayCreateAccount(db, { email, emailVerified: true }, [email])).toBe(false);
    expect(
      await mayCreateAccount(db, { email: email.toUpperCase(), emailVerified: true }, []),
    ).toBe(false);
  });

  it("mayStartSession refuses a station-only user, as it does a deactivated or unknown one", async () => {
    const regular = await userWith({});
    const deactivated = await userWith({ active: false });
    const stationOnly = await stationOnlyUser();

    expect(await mayStartSession(db, regular.id)).toEqual({ allowed: true });
    expect(await mayStartSession(db, deactivated.id)).toEqual({
      allowed: false,
      reason: "deactivated",
    });
    expect(await mayStartSession(db, stationOnly.id)).toEqual({
      allowed: false,
      reason: "stationOnly",
    });
    expect(await mayStartSession(db, crypto.randomUUID())).toEqual({
      allowed: false,
      reason: "deactivated",
    });
  });
});
