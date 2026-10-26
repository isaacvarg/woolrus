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
    // Resolving a void notifies its order; the Voids page and its nav count follow.
    orpc.voids.key(),
    // Reporting, editing or resolving an issue notifies its order; the Issues page and nav follow.
    orpc.issues.key(),
    orpc.sync.status.key(),
    // A batch's slot legend and My picks show the state of every member order.
    orpc.pickBatches.key(),
    orpc.picking.myPicks.key(),
  ];
  for (const key of keys) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

/** Every query that follows the order event stream: orders, their pick views and batches, notes. */
const followed = () => [
  orpc.orders.key(),
  orpc.picking.key(),
  orpc.packing.key(),
  orpc.pickBatches.key(),
  orpc.notes.key(),
];

function invalidateFollowed(queryClient: QueryClient) {
  for (const queryKey of followed()) void queryClient.invalidateQueries({ queryKey });
}

function invalidateOrders(queryClient: QueryClient, ids: Iterable<string>) {
  invalidateLists(queryClient);
  for (const id of ids) {
    void queryClient.invalidateQueries({ queryKey: orpc.orders.get.key({ input: { id } }) });
    void queryClient.invalidateQueries({ queryKey: orpc.orders.history.key({ input: { id } }) });
    void queryClient.invalidateQueries({
      queryKey: orpc.picking.view.key({ input: { orderId: id } }),
    });
    void queryClient.invalidateQueries({
      queryKey: orpc.packing.view.key({ input: { orderId: id } }),
    });
    // Notes change without touching the order, and say so with the same event.
    void queryClient.invalidateQueries({
      queryKey: orpc.notes.list.key({ input: { orderId: id } }),
    });
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
    for (const queryKey of followed()) {
      queryClient.setQueryDefaults(queryKey, {
        refetchInterval: () => (connected ? REFRESH_MS : POLL_MS),
      });
    }

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
        invalidateFollowed(queryClient);
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
        invalidateFollowed(queryClient);
      });
      source.onerror = () => {
        // EventSource retries on its own at a fixed rate, and gives up for good on an HTTP error
        // (a 401 after the session expires). Take over so both back off the same way.
        source?.close();
        if (connected) {
          connected = false;
          invalidateFollowed(queryClient);
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
      for (const queryKey of followed()) {
        queryClient.setQueryDefaults(queryKey, { refetchInterval: false });
      }
    };
  }, [queryClient]);
}

/** Mounts {@link useOrderEvents} from a server layout. */
export function OrderEvents() {
  useOrderEvents();
  return null;
}
