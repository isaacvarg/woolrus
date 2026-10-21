import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { contract } from "@woolrus/contracts";

export type ClientContext = {
  /** Upload progress from 0 to 1, for calls that send files (note photos). */
  onUploadProgress?: (fraction: number) => void;
};

/** Responses with these statuses can't carry a body, even an empty one. */
const NULL_BODY = new Set([101, 204, 205, 304]);

function parseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const at = line.indexOf(":");
    if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return headers;
}

/** fetch can't report upload progress; XMLHttpRequest can. Same-origin, so cookies go along. */
async function fetchWithProgress(
  request: Request,
  onProgress: (fraction: number) => void,
): Promise<Response> {
  const body = request.method === "GET" ? null : await request.blob();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(request.method, request.url);
    request.headers.forEach((value, key) => {
      xhr.setRequestHeader(key, value);
    });
    xhr.responseType = "blob";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () =>
      resolve(
        new Response(NULL_BODY.has(xhr.status) ? null : (xhr.response as Blob), {
          status: xhr.status,
          headers: parseHeaders(xhr.getAllResponseHeaders()),
        }),
      );
    xhr.onerror = () => reject(new TypeError("Network request failed"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    request.signal.addEventListener("abort", () => xhr.abort());
    xhr.send(body);
  });
}

const link = new RPCLink<ClientContext>({
  url: () => `${typeof window === "undefined" ? "http://localhost" : window.location.origin}/rpc`,
  fetch: (request, init, { context }) =>
    context.onUploadProgress
      ? fetchWithProgress(request, context.onUploadProgress)
      : fetch(request, init),
});

/** Typed API client. Used from client components only; server components call @woolrus/core directly. */
export const client: ContractRouterClient<typeof contract, ClientContext> = createORPCClient(link);

/** TanStack Query helpers: `useQuery(orpc.boxes.list.queryOptions({ input }))`. */
export const orpc = createTanstackQueryUtils(client);
