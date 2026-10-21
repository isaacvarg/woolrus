import { AwsClient } from "aws4fetch";
import { type ObjectStorage, StorageError, type StoredObject } from "./storage";

export type S3Config = {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
};

export type S3Options = { fetch?: typeof fetch; timeoutMs?: number };

const ENV = {
  endpoint: "S3_ENDPOINT",
  region: "S3_REGION",
  accessKey: "S3_ACCESS_KEY",
  secretKey: "S3_SECRET_KEY",
  bucket: "S3_BUCKET",
} as const;

/** Storage is infrastructure, so it's configured from env, not Settings (SPEC-notes). */
export function s3ConfigFromEnv(env: Record<string, string | undefined> = process.env): S3Config {
  const missing = Object.values(ENV).filter((name) => !env[name]);
  if (missing.length > 0)
    throw new Error(`Object storage is not configured: set ${missing.join(", ")}`);
  return Object.fromEntries(
    Object.entries(ENV).map(([field, name]) => [field, env[name] as string]),
  ) as S3Config;
}

/** `check()` answers `/api/health`, which must stay fast when storage hangs. */
const CHECK_TIMEOUT_MS = 2_000;
/** Deletes run in parallel, a few at a time, so a big sweep doesn't flood the server. */
const DELETE_CONCURRENCY = 8;

/** Encodes each path segment but keeps the slashes, so keys read naturally in URLs. */
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return XML_ENTITIES[name] ?? whole;
  });
const xmlValue = (xml: string, tag: string) =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];

/** Null when storage doesn't say (a chunked reply): an unknown size, not an empty file. */
function contentLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  return header === null ? null : Number(header);
}

function statusError(status: number, what: string): StorageError {
  const detail = `${status} ${what}`;
  if (status === 404) return new StorageError("notFound", detail);
  if (status === 416) return new StorageError("invalidRange", detail);
  if (status === 401 || status === 403) return new StorageError("unauthorized", detail);
  if (status === 429 || status >= 500) return new StorageError("unavailable", detail);
  return new StorageError("rejected", detail);
}

/**
 * S3 over plain `fetch`, signed with `aws4fetch` (SPEC-notes: no AWS SDK). Path-style URLs
 * (`<endpoint>/<bucket>/<key>`), which RustFS needs. It doesn't retry: jobs do, with backoff.
 */
export function createS3Storage(config: S3Config, options: S3Options = {}): ObjectStorage {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const client = new AwsClient({
    accessKeyId: config.accessKey,
    secretAccessKey: config.secretKey,
    region: config.region,
    service: "s3",
  });
  const bucketUrl = `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`;

  async function request(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs: ms = timeoutMs, ...rest } = init;
    const signed = await client.sign(url, rest);
    // The timeout covers waiting for storage to answer, not reading the body: a GET's body is
    // streamed to the browser, and a slow tablet or a paused <audio> may take longer than that.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("storage timed out", "TimeoutError")),
      ms,
    );
    try {
      // The original body, not the signed Request's stream: a stream goes out chunked under
      // Next's fetch, and RustFS refuses a PUT without Content-Length (411).
      return await doFetch(signed.url, {
        method: signed.method,
        headers: signed.headers,
        body: rest.body,
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new StorageError("unavailable", timedOut ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drops an unread body so the connection can be reused. Not awaited: nothing depends on it. */
  const discard = (response: Response) => {
    response.body?.cancel().catch(() => {});
  };

  async function headBucket(ms?: number): Promise<boolean> {
    const response = await request(bucketUrl, { method: "HEAD", timeoutMs: ms });
    discard(response);
    if (response.ok) return true;
    if (response.status === 404) return false;
    throw statusError(response.status, "HEAD bucket");
  }

  return {
    async put(key, body, contentType) {
      const response = await request(`${bucketUrl}/${encodeKey(key)}`, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        // Buffers and sharp output sit on an ArrayBuffer; the DOM types only rule out SharedArrayBuffer.
        body: body as Uint8Array<ArrayBuffer>,
      });
      discard(response);
      if (!response.ok) throw statusError(response.status, "PUT");
    },

    async get(key, range): Promise<StoredObject> {
      const response = await request(`${bucketUrl}/${encodeKey(key)}`, {
        method: "GET",
        headers: range ? { Range: range } : {},
      });
      if (!response.ok || !response.body) {
        discard(response);
        throw statusError(response.status, "GET");
      }
      return {
        body: response.body,
        size: contentLength(response),
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        contentRange: response.headers.get("content-range") ?? undefined,
      };
    },

    async delete(keys) {
      // One DELETE per key: S3 answers 204 for a missing key, and RustFS may answer 404; both
      // mean "gone". (Batch DeleteObjects needs an XML body and Content-MD5; not worth it here.)
      const queue = [...keys];
      const worker = async () => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
          const response = await request(`${bucketUrl}/${encodeKey(key)}`, { method: "DELETE" });
          discard(response);
          if (!response.ok && response.status !== 404) throw statusError(response.status, "DELETE");
        }
      };
      await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, keys.length) }, worker));
    },

    async *list(prefix, olderThan) {
      let token: string | undefined;
      do {
        const params = new URLSearchParams({ "list-type": "2", prefix });
        if (token) params.set("continuation-token", token);
        const response = await request(`${bucketUrl}?${params}`, { method: "GET" });
        const xml = await response.text();
        if (!response.ok) throw statusError(response.status, "LIST");
        for (const [, entry = ""] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = xmlValue(entry, "Key");
          const modified = xmlValue(entry, "LastModified");
          if (key === undefined || modified === undefined) continue;
          const lastModified = new Date(modified);
          if (lastModified < olderThan) yield { key: decodeXml(key), lastModified };
        }
        const truncated = xmlValue(xml, "IsTruncated") === "true";
        const next = xmlValue(xml, "NextContinuationToken");
        token = truncated && next ? decodeXml(next) : undefined;
      } while (token);
    },

    async ensureBucket() {
      if (await headBucket()) return;
      // No ACL header: a new bucket is private (owner only), which is what attachments need.
      const response = await request(bucketUrl, { method: "PUT" });
      discard(response);
      // 409 = another process created it between our HEAD and PUT.
      if (!response.ok && response.status !== 409) throw statusError(response.status, "PUT bucket");
    },

    async check() {
      try {
        return (await headBucket(CHECK_TIMEOUT_MS)) ? "ok" : "fail";
      } catch {
        return "fail";
      }
    },
  };
}
