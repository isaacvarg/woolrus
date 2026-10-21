import { AwsClient } from "aws4fetch";
import { describe, expect, it } from "vitest";
import { createS3Storage, type S3Config, s3ConfigFromEnv } from "./s3";
import { describeObjectStorage } from "./suite";

const config: S3Config = {
  endpoint: "http://storage.test:9000/",
  region: "us-east-1",
  accessKey: "test-access",
  secretKey: "test-secret",
  bucket: "attachments",
};

type Call = { method: string; url: URL; headers: Headers; body: string; rawBody: unknown };

/** A storage whose fetch answers from `replies` in order (the last one repeats). */
function setup(...replies: (Response | Error)[]) {
  const calls: Call[] = [];
  let i = 0;
  const fakeFetch = async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: request.body ? await request.text() : "",
      rawBody: init?.body,
    });
    const reply = replies[Math.min(i++, replies.length - 1)] as Response | Error;
    if (reply instanceof Error) throw reply;
    return reply.clone();
  };
  return { storage: createS3Storage(config, { fetch: fakeFetch as typeof fetch }), calls };
}

const listPage = (keys: [string, string][], next?: string) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>attachments</Name>${keys
      .map(
        ([k, d]) =>
          `<Contents><Key>${k}</Key><LastModified>${d}</LastModified><Size>1</Size></Contents>`,
      )
      .join("")}<IsTruncated>${next ? "true" : "false"}</IsTruncated>${
      next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""
    }</ListBucketResult>`,
    { status: 200, headers: { "content-type": "application/xml" } },
  );

describe("S3Storage requests", () => {
  it("signs a path-style PUT with the content type", async () => {
    const { storage, calls } = setup(new Response(null, { status: 200 }));
    await storage.put("notes/n1/a b.webp", new TextEncoder().encode("img"), "image/webp");
    const [call] = calls;
    expect(call?.method).toBe("PUT");
    expect(call?.url.href).toBe("http://storage.test:9000/attachments/notes/n1/a%20b.webp");
    expect(call?.headers.get("content-type")).toBe("image/webp");
    expect(call?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=test-access\/\d{8}\/us-east-1\/s3\/aws4_request/,
    );
    expect(call?.body).toBe("img");
    // Bytes, not a stream: a streamed body goes out chunked and RustFS wants Content-Length (411).
    expect(call?.rawBody).toBeInstanceOf(Uint8Array);
  });

  it("forwards a Range and reports the content range", async () => {
    const { storage, calls } = setup(
      new Response("0123", {
        status: 206,
        headers: {
          "content-type": "audio/webm",
          "content-length": "4",
          "content-range": "bytes 0-3/10",
        },
      }),
    );
    const object = await storage.get("notes/n1/v.webm", "bytes=0-3");
    expect(calls[0]?.headers.get("range")).toBe("bytes=0-3");
    expect(object).toMatchObject({
      size: 4,
      contentType: "audio/webm",
      contentRange: "bytes 0-3/10",
    });
    expect(await new Response(object.body).text()).toBe("0123");
  });

  it("maps statuses to error kinds", async () => {
    const get = (status: number) => setup(new Response("", { status })).storage.get("k");
    await expect(get(404)).rejects.toMatchObject({ kind: "notFound" });
    await expect(get(416)).rejects.toMatchObject({ kind: "invalidRange" });
    await expect(get(403)).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(get(400)).rejects.toMatchObject({ kind: "rejected" });
    await expect(get(503)).rejects.toMatchObject({ kind: "unavailable" });
    const down = setup(new TypeError("fetch failed")).storage;
    await expect(down.get("k")).rejects.toMatchObject({ kind: "unavailable", detail: "network" });
  });

  it("deletes each key and treats a missing one as success", async () => {
    const { storage, calls } = setup(
      new Response(null, { status: 204 }),
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
    );
    await storage.delete(["notes/a", "notes/b"]);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`).sort()).toEqual([
      "DELETE /attachments/notes/a",
      "DELETE /attachments/notes/b",
    ]);
  });

  it("lists every page and keeps only objects older than the cutoff", async () => {
    const { storage, calls } = setup(
      listPage(
        [
          ["notes/old&amp;1", "2026-10-01T00:00:00.000Z"],
          ["notes/new", "2026-10-21T00:00:00.000Z"],
        ],
        "page-2",
      ),
      listPage([["notes/old2", "2026-10-02T00:00:00.000Z"]]),
    );
    const listed: string[] = [];
    for await (const o of storage.list("notes/", new Date("2026-10-20T00:00:00Z")))
      listed.push(o.key);
    expect(listed).toEqual(["notes/old&1", "notes/old2"]);
    expect(calls[0]?.url.searchParams.get("list-type")).toBe("2");
    expect(calls[0]?.url.searchParams.get("prefix")).toBe("notes/");
    expect(calls[1]?.url.searchParams.get("continuation-token")).toBe("page-2");
  });

  it("creates the bucket only when HEAD says it's missing", async () => {
    const exists = setup(new Response(null, { status: 200 }));
    await exists.storage.ensureBucket();
    expect(exists.calls.map((c) => c.method)).toEqual(["HEAD"]);

    const missing = setup(new Response(null, { status: 404 }), new Response(null, { status: 200 }));
    await missing.storage.ensureBucket();
    expect(missing.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "HEAD /attachments",
      "PUT /attachments",
    ]);
    // Private: no ACL header, so the bucket keeps the default (owner only).
    expect(missing.calls[1]?.headers.get("x-amz-acl")).toBeNull();
  });

  it("check is HEAD bucket with a 2 s timeout and never throws", async () => {
    expect(await setup(new Response(null, { status: 200 })).storage.check()).toBe("ok");
    expect(await setup(new Response(null, { status: 404 })).storage.check()).toBe("fail");
    expect(await setup(new TypeError("fetch failed")).storage.check()).toBe("fail");

    let signal: AbortSignal | undefined;
    const hanging = createS3Storage(config, {
      fetch: ((input: Request | string | URL, init?: RequestInit) => {
        signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        return new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal?.reason)),
        );
      }) as typeof fetch,
    });
    const started = Date.now();
    expect(await hanging.check()).toBe("fail");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("s3ConfigFromEnv", () => {
  it("reads the five S3_ variables", () => {
    expect(
      s3ConfigFromEnv({
        S3_ENDPOINT: "http://localhost:9010",
        S3_REGION: "us-east-1",
        S3_ACCESS_KEY: "a",
        S3_SECRET_KEY: "s",
        S3_BUCKET: "b",
      }),
    ).toEqual({
      endpoint: "http://localhost:9010",
      region: "us-east-1",
      accessKey: "a",
      secretKey: "s",
      bucket: "b",
    });
  });

  it("names what's missing without echoing values", () => {
    expect(() => s3ConfigFromEnv({ S3_ENDPOINT: "http://x", S3_SECRET_KEY: "hush" })).toThrow(
      "S3_REGION, S3_ACCESS_KEY, S3_BUCKET",
    );
  });
});

// Opt-in: `STORAGE_LIVE=1 pnpm --filter @woolrus/core test -- adapters/storage` with
// `pnpm stack:up`. Each run uses a fresh bucket and removes it afterwards.
describe.skipIf(!process.env.STORAGE_LIVE)("S3Storage against the dev RustFS", () => {
  describeObjectStorage("S3Storage", async () => {
    const env = s3ConfigFromEnv();
    const live: S3Config = { ...env, bucket: `woolrus-test-${crypto.randomUUID().slice(0, 8)}` };
    const storage = createS3Storage(live);
    return {
      storage,
      async cleanup() {
        const keys: string[] = [];
        for await (const o of storage.list("", new Date(Date.now() + 60_000))) keys.push(o.key);
        await storage.delete(keys);
        const client = new AwsClient({
          accessKeyId: live.accessKey,
          secretAccessKey: live.secretKey,
          region: live.region,
          service: "s3",
        });
        await fetch(
          await client.sign(`${live.endpoint.replace(/\/$/, "")}/${live.bucket}`, {
            method: "DELETE",
          }),
        );
      },
    };
  });
});
