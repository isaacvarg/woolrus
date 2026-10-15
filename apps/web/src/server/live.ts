import { createOrderEventsHub, type OrderEventsHub } from "@woolrus/core";
import { createLogger } from "@woolrus/logger";

const log = createLogger({ module: "live" });

const globalForLive = globalThis as unknown as { woolrusOrderEvents?: OrderEventsHub };

function createHub(): OrderEventsHub {
  const hub = createOrderEventsHub({
    onError: (err) => log.warn({ err }, "order events LISTEN connection lost; reconnecting"),
  });
  // Next exits on its own after SIGTERM; this only closes the LISTEN connection on the way out.
  process.once("SIGTERM", () => void hub.close());
  return hub;
}

/**
 * The process's one LISTEN connection for order changes, shared by every SSE subscriber. Cached on
 * globalThis so dev reloads don't open another.
 */
export const orderEvents: OrderEventsHub = globalForLive.woolrusOrderEvents ?? createHub();
globalForLive.woolrusOrderEvents = orderEvents;

/** Keeps proxies and the browser from timing the stream out (SPEC-workflow "Live updates"). */
export const HEARTBEAT_MS = 25_000;
