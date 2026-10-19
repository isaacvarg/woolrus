"use client";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { OrderChangedEvent } from "@woolrus/core";
import { useEffect } from "react";
import { orpc } from "@/lib/orpc";

/** How often order queries refetch while the event stream is down (SPEC-workflow "Live updates"). */
const POLL_MS = 30_000;
/**
 * And while it's up: time changes things with no event (a stage passing its SLA, a claim expiring,
 * an order crossing an age rule before the next recompute).
 */
const REFRESH_MS = 60_000;
/** Reconnect delays after the stream fails; the last one repeats. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Collects bursts (a priority recompute notifies every open order) into one round of refetches. */
const BATCH_MS = 100;

/**
 * Every list of orders depends on any order, so these refetch on each event. So does the nav's
 * sync status: an import or a store change arrives as order events.
 */
function invalidateLists(queryClient: QueryClient) {
  const keys = [
    orpc.orders.queue.key(),
    orpc.orders.counts.key(),
    orpc.orders.list.key(),
    orpc.sync.status.key(),
  ];
  for (const key of keys) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

function invalidateOrders(queryClient: QueryClient, ids: Iterable<string>) {
  invalidateLists(queryClient);
  for (const id of ids) {
    void queryClient.invalidateQueries({ queryKey: orpc.orders.get.key({ input: { id } }) });
    void queryClient.invalidateQueries({ queryKey: orpc.orders.history.key({ input: { id } }) });
  }
}

/**
 * Keeps order queries fresh from `/api/events/orders`. Events only say which order changed; the
 * affected queries refetch, and every 60 s for what changes with time. While the stream is down,
 * they poll every 30 s instead, and it reconnects with backoff. Mount once per tab (`<OrderEvents />` in the app layout).
 */
export function useOrderEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let connected = false;
    // Evaluated again whenever a query updates; every change of `connected` below invalidates, so
    // the interval switches as soon as the refetch lands.
    queryClient.setQueryDefaults(orpc.orders.key(), {
      refetchInterval: () => (connected ? REFRESH_MS : POLL_MS),
    });

    let source: EventSource | undefined;
    let attempt = 0;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();

    const connect = () => {
      source = new EventSource("/api/events/orders");
      source.onopen = () => {
        attempt = 0;
        connected = true;
        // Changes made before the stream opened, or while it was down, sent no event here.
        void queryClient.invalidateQueries({ queryKey: orpc.orders.key() });
      };
      source.addEventListener("order_changed", (message) => {
        pending.add((JSON.parse(message.data) as OrderChangedEvent).id);
        flush ??= setTimeout(() => {
          flush = undefined;
          invalidateOrders(queryClient, pending);
          pending.clear();
        }, BATCH_MS);
      });
      source.addEventListener("resync", () => {
        void queryClient.invalidateQueries({ queryKey: orpc.orders.key() });
      });
      source.onerror = () => {
        // EventSource retries on its own at a fixed rate, and gives up for good on an HTTP error
        // (a 401 after the session expires). Take over so both back off the same way.
        source?.close();
        if (connected) {
          connected = false;
          void queryClient.invalidateQueries({ queryKey: orpc.orders.key() });
        }
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt += 1;
        reconnect = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      source?.close();
      clearTimeout(reconnect);
      clearTimeout(flush);
      queryClient.setQueryDefaults(orpc.orders.key(), { refetchInterval: false });
    };
  }, [queryClient]);
}

/** Mounts {@link useOrderEvents} from a server layout. */
export function OrderEvents() {
  useOrderEvents();
  return null;
}
