import pg from "pg";

export type Listener = { close(): Promise<void> };

export type ListenHandlers = {
  onMessage(payload: string): void;
  /** The connection failed or dropped. Called at most once; the listener is dead and the caller reconnects. */
  onError(error: Error): void;
};

/**
 * LISTENs on one channel over its own connection: notifications need a session that stays open,
 * which a pooled Prisma connection isn't.
 */
export async function listen(
  channel: string,
  handlers: ListenHandlers,
  connectionString = process.env.DATABASE_URL,
): Promise<Listener> {
  const client = new pg.Client({ connectionString });
  let closing = false;
  let failed = false;
  const fail = (error: Error) => {
    if (closing || failed) return;
    failed = true;
    handlers.onError(error);
    client.end().catch(() => {});
  };

  client.on("notification", (msg) => {
    if (msg.channel === channel && msg.payload !== undefined) handlers.onMessage(msg.payload);
  });
  client.on("error", fail);
  client.on("end", () => fail(new Error("LISTEN connection ended")));

  try {
    await client.connect();
    await client.query(`LISTEN ${client.escapeIdentifier(channel)}`);
  } catch (error) {
    closing = true;
    await client.end().catch(() => {});
    throw error;
  }

  return {
    async close() {
      closing = true;
      await client.end();
    },
  };
}
