import { defineActions } from "./types";

// Picking: picks, batches and barcode links. Wording and `describe` come with #199.

export const pickingActions = defineActions({
  "pick.scan": { category: "picking", groups: true },
  "pick.pickLine": { category: "picking", groups: true },
  "pick.unpickLine": { category: "picking", groups: true },
  "pick.markOutOfStock": { category: "picking", groups: false },
  "pickBatch.create": { category: "picking", groups: false },
  "pickBatch.removeOrder": { category: "picking", groups: false },
  "pickBatch.close": { category: "picking", groups: false },
  "pickBatch.finish": { category: "picking", groups: false },
  "product.linkBarcode": { category: "picking", groups: false },
});
