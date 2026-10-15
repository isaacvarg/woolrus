import { can, type OrderEventsMessage } from "@woolrus/core";
import { resolveActor } from "@/server/actor";
import { HEARTBEAT_MS, orderEvents } from "@/server/live";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function frame(message: OrderEventsMessage): string {
  return message.type === "changed"
    ? `event: order_changed\ndata: ${JSON.stringify(message.event)}\n\n`
    : "event: resync\ndata: {}\n\n";
}

/**
 * Server-sent events for order changes: `order_changed` with `{ id, status }` (never PII), and
 * `resync` when events may have been missed. Clients refetch what's affected; they never apply data
 * from here directly. Same session rules as the API (cookie or bearer), checked again on every
 * heartbeat.
 */
export async function GET(request: Request) {
  const resolved = await resolveActor(request.headers);
  if (!resolved) {
    return Response.json({ messageKey: "errors.unauthenticated" }, { status: 401 });
  }
  if (!can(resolved.actor, "order.read")) {
    return Response.json({ messageKey: "errors.forbidden" }, { status: 403 });
  }

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup(); // The stream already closed.
        }
      };
      const end = () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      };
      const unsubscribe = orderEvents.subscribe((message) => send(frame(message)));
      const heartbeat = setInterval(async () => {
        send(": heartbeat\n\n");
        // The session can expire, or the user be deactivated, while the stream is open. When it
        // can't be checked (database down), end it too: the client reconnects and is checked again.
        const current = await resolveActor(request.headers).catch(() => null);
        if (!current || !can(current.actor, "order.read")) end();
      }, HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.signal.addEventListener("abort", end);
      // Tells EventSource how long to wait before reconnecting, and flushes the headers now.
      send("retry: 5000\n: connected\n\n");
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
