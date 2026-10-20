"use client";

import { ORPCError } from "@orpc/client";
import { useEffect, useRef, useState } from "react";
import { client } from "@/lib/orpc";

const TOUCH_EVERY_MS = 60_000;
/** Inside this much of the deadline, any input touches: otherwise a short limit lapses mid-work. */
const TOUCH_NEAR_DEADLINE_MS = 30_000;

/**
 * Idle lock on the client (SPEC-identity "Idle lock"). Pointer, key and scan input (a scanner
 * types keys) pushes the server's deadline out with `station.touch`: at most once a minute, but
 * always when the deadline is near, so even a 1-minute limit holds while someone is working.
 * Background refetches and SSE never call it. At the deadline the lock screen shows on its own;
 * the server has the final say and ends the turn on the next request after it.
 */
export function StationIdleLock({ idleLockAt }: { idleLockAt: Date }) {
  const [deadline, setDeadline] = useState(idleLockAt.getTime());
  const deadlineRef = useRef(deadline);
  deadlineRef.current = deadline;
  const lastTouch = useRef(0);

  useEffect(() => {
    const onInput = () => {
      const now = Date.now();
      const near = deadlineRef.current - now <= TOUCH_NEAR_DEADLINE_MS;
      if (now - lastTouch.current < TOUCH_EVERY_MS && !near) return;
      // Never more than one touch in flight or within a few seconds, however fast the input.
      if (now - lastTouch.current < 5_000) return;
      lastTouch.current = now;
      client.station.touch().then(
        ({ idleLockAt: next }) => setDeadline(next.getTime()),
        (error: unknown) => {
          // Only the server saying the turn is over locks the screen; a network blip doesn't.
          const key = error instanceof ORPCError ? error.data?.messageKey : undefined;
          if (key === "errors.station.locked") setDeadline(0);
        },
      );
    };
    const events = ["pointerdown", "keydown"] as const;
    for (const event of events) window.addEventListener(event, onInput, { capture: true });
    return () => {
      for (const event of events) window.removeEventListener(event, onInput, { capture: true });
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(
      () => window.location.assign("/station"),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [deadline]);

  return null;
}
