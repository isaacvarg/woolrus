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
] as const;
