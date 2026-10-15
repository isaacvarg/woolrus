import { WorkflowStatus } from "@woolrus/contracts";
import { type Listener, type ListenHandlers, listen } from "@woolrus/db";
import { ORDER_CHANGED_CHANNEL, type OrderChangedEvent } from "./notify";

// Fans `order_changed` notifications out to in-process subscribers (the SSE route) over one LISTEN
// connection per process (SPEC-workflow "Live updates"). Notifications sent while the connection is
// down are lost, so after any outage subscribers get `resync` and should refetch everything.

export type OrderEventsMessage = { type: "changed"; event: OrderChangedEvent } | { type: "resync" };

export type OrderEventsHub = {
  /** Starts listening on the first subscriber. Returns the unsubscribe function. */
  subscribe(fn: (message: OrderEventsMessage) => void): () => void;
  /** Resolves once the LISTEN connection is up. */
  ready(): Promise<void>;
  /** Closes the connection and stops reconnecting, e.g. on SIGTERM. */
  close(): Promise<void>;
};

export type OrderEventsHubOptions = {
  connect?: (handlers: ListenHandlers) => Promise<Listener>;
  /** Wait before each reconnect attempt; the last value repeats. */
  retryDelaysMs?: readonly number[];
  /** A connect failure or a dropped connection; the hub retries on its own. */
  onError?: (error: unknown) => void;
};

function parseEvent(payload: string): OrderChangedEvent | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== "object" || value === null) return null;
    const { id, status } = value as Record<string, unknown>;
    const parsed = WorkflowStatus.safeParse(status);
    return typeof id === "string" && parsed.success ? { id, status: parsed.data } : null;
  } catch {
    return null;
  }
}

export function createOrderEventsHub({
  connect = (handlers) => listen(ORDER_CHANGED_CHANNEL, handlers),
  retryDelaysMs = [1_000, 2_000, 5_000, 10_000],
  onError = () => {},
}: OrderEventsHubOptions = {}): OrderEventsHub {
  const subscribers = new Set<(message: OrderEventsMessage) => void>();
  let listener: Listener | null = null;
  let started = false;
  let closed = false;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let waiters: (() => void)[] = [];

  const broadcast = (message: OrderEventsMessage) => {
    for (const fn of subscribers) fn(message);
  };

  const scheduleRetry = () => {
    const delay = retryDelaysMs[Math.min(failures, retryDelaysMs.length) - 1] ?? 1_000;
    retryTimer = setTimeout(() => void open(), delay);
  };

  async function open(): Promise<void> {
    if (closed) return;
    try {
      const opened = await connect({
        onMessage(payload) {
          const event = parseEvent(payload);
          if (event) broadcast({ type: "changed", event });
        },
        onError(error) {
          if (closed) return;
          listener = null;
          failures += 1;
          onError(error);
          scheduleRetry();
        },
      });
      if (closed) {
        await opened.close();
        return;
      }
      listener = opened;
      // Anything sent before this point is lost, so whoever was waiting must refetch.
      if (failures > 0) broadcast({ type: "resync" });
      failures = 0;
      for (const resolve of waiters) resolve();
      waiters = [];
    } catch (error) {
      failures += 1;
      onError(error);
      scheduleRetry();
    }
  }

  return {
    subscribe(fn) {
      subscribers.add(fn);
      if (!started) {
        started = true;
        void open();
      }
      return () => {
        subscribers.delete(fn);
      };
    },
    ready() {
      return listener ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve));
    },
    async close() {
      closed = true;
      clearTimeout(retryTimer);
      subscribers.clear();
      const current = listener;
      listener = null;
      await current?.close();
    },
  };
}
