import type { QaPackage } from "@woolrus/contracts";

/** A label that exists or may exist at the carrier: the package's rate and the address are fixed. */
export const hasLiveLabel = (pkg: QaPackage) =>
  pkg.label !== null && pkg.label.status !== "PURCHASE_FAILED" && pkg.label.status !== "VOIDED";
