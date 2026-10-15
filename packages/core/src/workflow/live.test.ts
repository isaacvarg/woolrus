import { type Db, type ListenHandlers, listen } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { createOrderEventsHub, type OrderEventsHub, type OrderEventsMessage } from "./live";
import { ORDER_CHANGED_CHANNEL } from "./notify";
import { beginPicking } from "./service";

const db: Db = testDb();
afterAll(() => db.$disconnect());

const realConnect = (handlers: ListenHandlers) =>
  listen(ORDER_CHANGED_CHANNEL, handlers, process.env.TEST_DATABASE_URL);

/** Resolves with the first message `pick` accepts, or rejects after `ms`. */
function nextMessage(
  hub: OrderEventsHub,
  pick: (m: OrderEventsMessage) => boolean = () => true,
  ms = 2_000,
): Promise<OrderEventsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no matching message within ${ms} ms`));
    }, ms);
    const unsubscribe = hub.subscribe((m) => {
      if (!pick(m)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(m);
    });
  });
}

describe("order events hub (real LISTEN)", () => {
  let hub: OrderEventsHub;
  beforeEach(async () => {
    await resetDb(db);
    hub = createOrderEventsHub({ connect: realConnect, retryDelaysMs: [50] });
  });
  afterEach(() => hub.close());

  it("delivers a committed transition to subscribers within 2 s", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);
    const received = nextMessage(hub);
    await hub.ready();

    await beginPicking(db, picker, { orderId: order.id, expectedVersion: 1 });

    expect(await received).toEqual({
      type: "changed",
      event: { id: order.id, status: "PICKING" },
    });
  });

  it("reconnects after Postgres drops the connection, and tells subscribers to resync", async () => {
    const picker = await createActor(db, ["PICKER"]);
    const { order } = await createOrder(db);
    const resync = nextMessage(hub, (m) => m.type === "resync");
    await hub.ready();

    await db.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE query = ${`LISTEN "${ORDER_CHANGED_CHANNEL}"`} AND pid <> pg_backend_pid()`;
    await resync;

    const changed = nextMessage(hub, (m) => m.type === "changed");
    await beginPicking(db, picker, { orderId: order.id, expectedVersion: 1 });
    expect(await changed).toMatchObject({ event: { id: order.id } });
  });
});

/** A connect function the test drives by hand. */
function fakeConnect() {
  const connections: { handlers: ListenHandlers; closed: boolean }[] = [];
  const connect = vi.fn(async (handlers: ListenHandlers) => {
    const connection = { handlers, closed: false };
    connections.push(connection);
    return {
      close: async () => {
        connection.closed = true;
      },
    };
  });
  return { connect, connections };
}

describe("order events hub", () => {
  it("connects only once someone subscribes, and only once for many subscribers", async () => {
    const { connect } = fakeConnect();
    const hub = createOrderEventsHub({ connect });
    expect(connect).not.toHaveBeenCalled();

    hub.subscribe(() => {});
    hub.subscribe(() => {});
    await hub.ready();

    expect(connect).toHaveBeenCalledTimes(1);
    await hub.close();
  });

  it("fans events out, stops after unsubscribe and ignores malformed payloads", async () => {
    const { connect, connections } = fakeConnect();
    const hub = createOrderEventsHub({ connect });
    const [a, b] = [vi.fn(), vi.fn()];
    const stopA = hub.subscribe(a);
    hub.subscribe(b);
    await hub.ready();
    const send = (payload: string) => connections[0]?.handlers.onMessage(payload);

    send(JSON.stringify({ id: "o1", status: "PICKING" }));
    stopA();
    send(JSON.stringify({ id: "o2", status: "QA" }));
    send("not json");
    send(JSON.stringify({ id: "o3", status: "NOPE" }));
    send(JSON.stringify({ id: 4, status: "QA" }));

    expect(a.mock.calls).toEqual([[{ type: "changed", event: { id: "o1", status: "PICKING" } }]]);
    expect(b.mock.calls.map(([m]) => m.event.id)).toEqual(["o1", "o2"]);
    await hub.close();
  });

  it("retries a failed connect with backoff, then resyncs", async () => {
    const { connections } = fakeConnect();
    let attempts = 0;
    const onError = vi.fn();
    const hub = createOrderEventsHub({
      connect: async (handlers) => {
        attempts += 1;
        if (attempts < 3) throw new Error("db down");
        connections.push({ handlers, closed: false });
        return { close: async () => {} };
      },
      retryDelaysMs: [1, 1],
      onError,
    });
    const seen: OrderEventsMessage[] = [];
    hub.subscribe((m) => seen.push(m));

    await vi.waitFor(() => expect(connections).toHaveLength(1));
    expect(attempts).toBe(3);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([{ type: "resync" }]);
    await hub.close();
  });

  it("closes the listener and stops reconnecting once closed", async () => {
    const { connect, connections } = fakeConnect();
    const hub = createOrderEventsHub({ connect, retryDelaysMs: [1] });
    hub.subscribe(() => {});
    await hub.ready();

    await hub.close();
    connections[0]?.handlers.onError(new Error("dropped after close"));
    await new Promise((r) => setTimeout(r, 20));

    expect(connections[0]?.closed).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
