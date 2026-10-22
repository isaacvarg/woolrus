import http from "node:http";
import { expect, type Page, test } from "@playwright/test";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

// Request-body limits on /rpc and /api/v1 (notes ship review): 160 MB only for a signed-in note
// upload, 1 MB for every other call, and a signed-out upload is refused before its body is read.

test.afterAll(deleteCreatedOrders);

const desktopOnly = (projectName: string) =>
  test.skip(projectName !== "desktop", "API checks; once is enough");

const MB = 1024 * 1024;

type Raw = { status: number; body: string; finishedSending: boolean };

/**
 * A raw request whose body is written in 64 KB chunks with a pause between them. It resolves on
 * the response, and says whether the whole body had been sent by then: a reply that comes first
 * proves the server answered without reading it.
 */
function raw(
  baseURL: string,
  {
    method = "POST",
    path,
    headers = {},
    bytes = 0,
    declaredLength,
  }: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    bytes?: number;
    declaredLength?: number;
  },
): Promise<Raw> {
  const url = new URL(path, baseURL);
  return new Promise((resolve, reject) => {
    let finishedSending = false;
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...headers,
          ...(declaredLength === undefined
            ? { "transfer-encoding": "chunked" }
            : { "content-length": String(declaredLength) }),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body, finishedSending });
          req.destroy();
        });
      },
    );
    // The server may close the socket once it has answered; that isn't a failure here.
    req.on("error", (error) => {
      if (!finishedSending) return;
      reject(error);
    });
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024, "a");
    const pump = () => {
      if (req.destroyed) return;
      if (sent >= bytes) {
        finishedSending = true;
        req.end();
        return;
      }
      req.write(chunk.subarray(0, Math.min(chunk.length, bytes - sent)));
      sent += chunk.length;
      // Slow enough that a busy server (CI runs the suite in parallel) answers well before the
      // last chunk: a reply after the body is all sent can arrive as ECONNRESET instead.
      setTimeout(pump, 20);
    };
    if (declaredLength === undefined) pump();
    else req.flushHeaders();
  });
}

const cookieHeader = async (page: Page) =>
  (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");

test("a signed-out note upload is refused before its body is read", async ({
  baseURL,
}, testInfo) => {
  desktopOnly(testInfo.project.name);
  const order = await createOrder();
  for (const path of [`/api/v1/orders/${order.id}/notes`, "/rpc/notes/create"]) {
    const response = await raw(baseURL ?? "", {
      path,
      headers: { "content-type": "multipart/form-data; boundary=x" },
      bytes: 20 * MB,
    });
    expect(response.status, path).toBe(401);
    expect(response.body, path).toContain("errors.unauthenticated");
    expect(response.finishedSending, path).toBe(false);
  }
});

test("any other call over 1 MB gets 413, declared or streamed", async ({
  page,
  baseURL,
}, testInfo) => {
  desktopOnly(testInfo.project.name);
  await signInAs(page, ["ADMIN"]);
  const headers = { cookie: await cookieHeader(page), "content-type": "application/json" };
  const declared = await raw(baseURL ?? "", {
    path: "/api/v1/boxes",
    headers,
    declaredLength: 2 * MB,
  });
  expect(declared.status).toBe(413);
  const streamed = await raw(baseURL ?? "", { path: "/api/v1/boxes", headers, bytes: 2 * MB });
  expect(streamed.status).toBe(413);
  // A signed-out caller gets the same limit, not the upload one.
  const anonymous = await raw(baseURL ?? "", {
    path: "/rpc/orders/list",
    headers: { "content-type": "application/json" },
    bytes: 2 * MB,
  });
  expect(anonymous.status).toBe(413);
});

test("a signed-in note upload may be larger than 1 MB, up to the upload limit", async ({
  page,
  baseURL,
}, testInfo) => {
  desktopOnly(testInfo.project.name);
  const order = await createOrder();
  await signInAs(page, ["PICKER"]);
  // An Ogg container header then padding: a 2 MB voice memo.
  const memo = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(2 * MB - 4, 0)]);
  const response = await page.request.post(`/api/v1/orders/${order.id}/notes`, {
    multipart: {
      idempotencyKey: crypto.randomUUID(),
      content: "",
      voice: { name: "memo.ogg", mimeType: "audio/ogg", buffer: memo },
      voiceDurationMs: "20000",
    },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({
    attachments: [{ kind: "VOICE", contentType: "audio/ogg", sizeBytes: 2 * MB }],
  });

  const tooBig = await raw(baseURL ?? "", {
    path: `/api/v1/orders/${order.id}/notes`,
    headers: {
      cookie: await cookieHeader(page),
      "content-type": "multipart/form-data; boundary=x",
    },
    declaredLength: 161 * MB,
  });
  expect(tooBig.status).toBe(413);
});
