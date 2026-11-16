import type { PackCheck, QaBoxConfirm } from "@woolrus/db";

// Which packages QA confirms the box of (SPEC-packing A1 "QA side"). Pure and import-free, so the
// verified gate and the QA view agree without the gates importing the QA services.

/** The trips about the box itself: confirming the box on the bench acknowledges them (decision 19). */
export const BOX_CHECKS: readonly PackCheck[] = [
  "NO_FIT",
  "UNDER_MIN",
  "OVER_MAX",
  "BOX_NOT_SCANNED",
  "CUSTOM_DIMENSIONS",
];

/** Whether QA must confirm a package's box: `tripCount` is its saved trips, acknowledged or not. */
export const boxConfirmRequired = (mode: QaBoxConfirm, tripCount: number): boolean =>
  mode === "ALWAYS" || (mode === "WHEN_TRIPPED" && tripCount > 0);
