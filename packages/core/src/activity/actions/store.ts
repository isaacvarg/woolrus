import { defineActions } from "./types";

// Store: imports, changes made in WooCommerce, and PII removal (SPEC-order-activity "Action registry").

export const storeActions = defineActions({
  /** Shown by the import's stage event (`stage.import`). */
  "order.import": { category: "store", groups: false, hidden: true, system: "store-sync" },
  "order.externalChange.flagged": { category: "store", groups: false, system: "store-sync" },
  "order.externalChange.applied": { category: "store", groups: false, system: "store-sync" },
  "order.externalChange.cleared": { category: "store", groups: false, system: "store-sync" },
  "order.externalChange.dismissed": { category: "store", groups: false },
  "pii.anonymize": { category: "store", groups: false, system: "operations" },
});
