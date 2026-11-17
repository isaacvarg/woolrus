import { defineActions } from "./types";

// Packing: packages, units, weights, box scans and lots at packing. Wording comes with #200.

export const packingActions = defineActions({
  "package.add": { category: "packing", groups: false },
  "package.delete": { category: "packing", groups: false },
  "package.setBox": { category: "packing", groups: false },
  "package.setWeight": { category: "packing", groups: false },
  "package.scan": { category: "packing", groups: true },
  "package.packUnits": { category: "packing", groups: true },
  "package.unpackUnits": { category: "packing", groups: true },
  "package.packRemaining": { category: "packing", groups: false },
  "lot.scan": { category: "packing", groups: true },
  "lot.remove": { category: "packing", groups: false },
  "lot.setQuantity": { category: "packing", groups: false },
  "lot.validate": { category: "packing", groups: false, system: "lumexia" },
});
