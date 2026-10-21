import { useEffect, useRef } from "react";

// Barcode scanners in HID mode (decisions.md § Platform) type the code as keystrokes and press Enter.
// A scan is a fast burst: keys more than 50 ms apart start over, so a person typing isn't a scan.
// Keys typed into a field or a dialog are never taken (SPEC-picking "Code matching").

const MAX_GAP_MS = 50;
/** Shorter bursts are stray keys, not codes. */
const MIN_LENGTH = 2;

export type ScanKey = { key: string; time: number; target: unknown };

const typingSelector =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], dialog';

/** Whether a key on `target` belongs to someone typing: a field, editable text or an open dialog. */
export function isTypingTarget(target: unknown): boolean {
  const closest = (target as { closest?: unknown } | null)?.closest;
  return typeof closest === "function" && closest.call(target, typingSelector) != null;
}

/** Collects keys into codes. `handle` returns true when the key ended a scan and should go no further. */
export function createScanBuffer(onScan: (code: string) => void) {
  let buffer = "";
  let last = Number.NEGATIVE_INFINITY;
  return {
    handle({ key, time, target }: ScanKey): boolean {
      if (isTypingTarget(target)) {
        buffer = "";
        return false;
      }
      if (key === "Enter") {
        const code = time - last <= MAX_GAP_MS ? buffer : "";
        buffer = "";
        if (code.length < MIN_LENGTH) return false;
        onScan(code);
        return true;
      }
      // Shift (scanners hold it for capitals) and other named keys don't break a burst.
      if (key.length !== 1) return false;
      buffer = time - last > MAX_GAP_MS ? key : buffer + key;
      last = time;
      return false;
    },
  };
}

/** Calls `onScan` with each code the scanner types on this page while `enabled`. */
export function useScanner(onScan: (code: string) => void, enabled = true) {
  const latest = useRef(onScan);
  latest.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const buffer = createScanBuffer((code) => latest.current(code));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (buffer.handle({ key: event.key, time: event.timeStamp, target: event.target })) {
        // The scanner's Enter mustn't also press whatever button has focus.
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // Capture phase, so the Enter is stopped before a focused card's own handler sees it.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}

let audio: AudioContext | null = null;

/** A short beep for a scan: high when it counted, low when it was refused. Silent if audio is blocked. */
export function playScanSound(ok: boolean) {
  try {
    audio ??= new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = ok ? 1320 : 220;
    oscillator.type = ok ? "sine" : "square";
    gain.gain.value = 0.1;
    oscillator.connect(gain).connect(audio.destination);
    const end = audio.currentTime + (ok ? 0.08 : 0.25);
    oscillator.start();
    oscillator.stop(end);
  } catch {
    // No audio (old browser, autoplay policy): the banner still says what happened.
  }
}
