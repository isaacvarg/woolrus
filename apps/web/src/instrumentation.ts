import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { initErrorReporting } = await import("./server/error-reporting");
  initErrorReporting();
  // Fail at startup, not on the first page, when the warehouse time zone is missing or wrong.
  const { warehouseTimeZone } = await import("./server/env");
  warehouseTimeZone();
}

/** Route-handler, server-component and server-action errors Next itself caught. */
export const onRequestError: Instrumentation.onRequestError = async (err, request) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureServerError } = await import("./server/error-reporting");
  const requestId = request.headers["x-request-id"];
  captureServerError(err, { requestId: Array.isArray(requestId) ? requestId[0] : requestId });
};
