"use client";

import { useEffect, useRef, useState } from "react";
import { client } from "@/lib/orpc";

const TOUCH_EVERY_MS = 60_000;

/**
 * Idle lock on the client (SPEC-identity "Idle lock"). Pointer, key and scan input (a scanner
 * types keys) pushes the server's deadline out with `station.touch`, at most once a minute;
 * background refetches and SSE never call it. At the deadline the lock screen shows on its own;
 * the server has the final say and ends the turn on the next request after it.
 */
export function StationIdleLock({ idleLockAt }: { idleLockAt: Date }) {
  const [deadline, setDeadline] = useState(idleLockAt.getTime());
  const lastTouch = useRef(0);

  useEffect(() => {
    const onInput = () => {
      const now = Date.now();
      if (now - lastTouch.current < TOUCH_EVERY_MS) return;
      lastTouch.current = now;
      // A refusal (`errors.station.locked`) means the deadline already passed: the timer below
      // shows the lock screen.
      client.station.touch().then(
        ({ idleLockAt: next }) => setDeadline(next.getTime()),
        () => setDeadline(0),
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
