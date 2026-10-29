/**
 * Customer PII keys (SPEC-operations "Error tracking"). Logs redact them here; error reports and
 * audit rows scrub the same list, so all three agree on what counts as personal data.
 */
export const PII_KEYS = [
  "customerName",
  "customerEmail",
  "email",
  "phone",
  "first_name",
  "last_name",
  "address_1",
  "address_2",
  "shippingAddress",
  "billingAddress",
  "shipTo",
  "shipToOriginal",
  "customerNote",
  // WooCommerce's own spellings and whole address objects.
  "customer_note",
  "customer_ip_address",
  "phone_number",
  "company",
  "city",
  "billing",
  "shipping",
  "billing_phone",
  "billing_email",
  "shipping_phone",
  "full_name",
  "ip_address",
  "username",
] as const;

/** Case, `_` and `-` don't matter: `Customer_Email`, `customerEmail` and `customer-email` are one key. */
const normalize = (key: string) => key.toLowerCase().replace(/[_-]/g, "");
const NORMALIZED = new Set<string>(PII_KEYS.map(normalize));

/** Whether `key` names customer PII, whatever its casing or separators. */
export const isPiiKey = (key: string): boolean => NORMALIZED.has(normalize(key));

const MAX_TEXT = 2000;
/** Bounded local part and domain labels: a long run of address-like characters can't go quadratic. */
const EMAIL = /[^\s@<>"']{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g;

/**
 * `text` with email addresses replaced by `[redacted]`. Looks at the first 2000 characters only and
 * drops the rest: messages that long are never worth keeping, and it bounds the work.
 */
export function maskEmails(text: string): string {
  const head = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  return head.replace(EMAIL, "[redacted]");
}

/** The value fields of a `{ key, value }` meta pair. */
export const PAIR_VALUES: ReadonlySet<string> = new Set(["value", "display_value"]);

/** Whether `object` is a meta pair whose `key` (or `display_key`) names customer PII. */
export function isPiiMetaPair(object: object): boolean {
  const { key, display_key: displayKey } = object as { key?: unknown; display_key?: unknown };
  return [key, displayKey].some((name) => typeof name === "string" && isPiiKey(name));
}
