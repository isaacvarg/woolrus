import { defineActions } from "./types";

// Shipping: rates, ship-to, labels, prints and the Woo push. Wording comes with #202.

export const shippingActions = defineActions({
  "rates.refresh": { category: "shipping", groups: true },
  "rate.select": { category: "shipping", groups: false },
  "rate.reason": { category: "shipping", groups: false },
  "shipTo.useOriginal": { category: "shipping", groups: false },
  "shipTo.recheck": { category: "shipping", groups: false },
  "labels.purchaseRequested": { category: "shipping", groups: false },
  "label.purchase": { category: "shipping", groups: false },
  "label.void": { category: "shipping", groups: false },
  "label.voided": { category: "shipping", groups: false },
  "label.voidRejected": { category: "shipping", groups: false },
  "label.markNotBought": { category: "shipping", groups: false },
  "label.writeOff": { category: "shipping", groups: false },
  "label.print": { category: "shipping", groups: true },
  "woo.push": { category: "shipping", groups: false, system: "shipping" },
  "woo.push.failed": { category: "shipping", groups: false, system: "shipping" },
  "woo.push.retry": { category: "shipping", groups: false },
});
