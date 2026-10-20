import { describe, expect, it } from "vitest";
import invalidKey from "./__fixtures__/error-403-invalid-api-key.json" with { type: "json" };
import concurrent from "./__fixtures__/error-409-concurrent.json" with { type: "json" };
import validation from "./__fixtures__/error-422-validation.json" with { type: "json" };
import rateLimit from "./__fixtures__/error-429-rate-limit.json" with { type: "json" };
import serverError from "./__fixtures__/error-500.json" with { type: "json" };
import sent from "./__fixtures__/sent.json" with { type: "json" };
import { createResendSender } from "./resend";
import { EmailError } from "./sender";

const config = { apiKey: "re_test_key_123", from: "Woolrus <no-reply@example.com>" };
const message = {
  to: "ana@example.com",
  subject: "Hello",
  html: "<p>Hello</p>",
  text: "Hello",
  idempotencyKey: "invite-1",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function setup(reply: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sender = createResendSender(config, {
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  return { sender, calls };
}

async function failure(reply: Response | Error): Promise<EmailError> {
  const error = await setup(reply)
    .sender.send(message)
    .then(
      () => null,
      (e: unknown) => e,
    );
  if (!(error instanceof EmailError)) throw new Error(`expected an EmailError, got ${error}`);
  return error;
}

describe("Resend email sender", () => {
  it("posts the message with the key, the sender and the idempotency key", async () => {
    const { sender, calls } = setup(json(sent, 200));
    await sender.send(message);

    expect(sender.kind).toBe("resend");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("authorization")).toBe("Bearer re_test_key_123");
    expect(new Headers(call?.init.headers).get("content-type")).toBe("application/json");
    expect(new Headers(call?.init.headers).get("idempotency-key")).toBe("invite-1");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      from: "Woolrus <no-reply@example.com>",
      to: ["ana@example.com"],
      subject: "Hello",
      html: "<p>Hello</p>",
      text: "Hello",
    });
  });

  it.each([
    ["a wrong key (403)", invalidKey, 403, "unauthorized"],
    ["an invalid message (422)", validation, 422, "rejected"],
  ] as const)("treats %s as permanent", async (_, body, status, kind) => {
    const error = await failure(json(body, status));
    expect(error).toMatchObject({ kind, status, permanent: true });
    expect(error.messageKey).toBe(`errors.email.${kind}`);
    expect(error.detail).toBe(`${status} ${body.name}`);
  });

  it.each([
    ["rate limiting (429)", rateLimit, 429],
    ["a server error (500)", serverError, 500],
    ["the same key still in flight (409)", concurrent, 409],
  ] as const)("throws a retryable error for %s", async (_, body, status) => {
    const error = await failure(json(body, status));
    expect(error).toMatchObject({ kind: "unavailable", status, permanent: false });
  });

  it("throws a retryable error when Resend can't be reached", async () => {
    const error = await failure(new TypeError("fetch failed"));
    expect(error).toMatchObject({ kind: "unavailable", permanent: false });
  });

  it("gives up after the timeout, retryably", async () => {
    const sender = createResendSender(config, {
      timeoutMs: 5,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    });
    await expect(sender.send(message)).rejects.toMatchObject({
      kind: "unavailable",
      permanent: false,
    });
  });

  it("keeps the key and the message out of its errors", async () => {
    const error = await failure(json(validation, 422));
    const shown = JSON.stringify({ ...error, message: error.message });
    expect(shown).not.toContain(config.apiKey);
    expect(shown).not.toContain(message.to);
    expect(shown).not.toContain(validation.message);
  });
});
