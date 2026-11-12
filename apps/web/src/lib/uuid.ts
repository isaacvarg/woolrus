/**
 * A random v4 UUID, in the browser as well as on the server. `crypto.randomUUID` only exists in
 * secure contexts (HTTPS or localhost), so a device on plain-HTTP LAN would crash without the
 * fallback; `crypto.getRandomValues` is available everywhere.
 */
export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const [b6 = 0, b8 = 0] = [bytes[6], bytes[8]];
  bytes[6] = (b6 & 0x0f) | 0x40; // version 4
  bytes[8] = (b8 & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
