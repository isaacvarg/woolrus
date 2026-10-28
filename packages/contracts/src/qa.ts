import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";
import { LineAttribute, OrderDetail } from "./orders";

// QA (SPEC-qa "API"). Writes need the order in QA and the caller's live claim.

const tags = ["QA"];

export const LabelState = z.enum([
  "PURCHASING",
  "ACTIVE",
  "PURCHASE_FAILED",
  "VOID_REQUESTED",
  "VOIDED",
  "VOID_REJECTED",
]);
export type LabelState = z.infer<typeof LabelState>;

/** A package's label as QA sees it: state, what was bought and what went wrong (a message key). */
export const QaLabel = z.object({
  id: Id,
  status: LabelState,
  trackingNumber: z.string().nullable(),
  carrierCode: z.string(),
  serviceCode: z.string(),
  costCents: z.number().int().nullable(),
  quotedAmountCents: z.number().int().nullable(),
  /** A message key (`errors.*`), never literal text. */
  error: z.string().nullable(),
  purchasedBy: z.string().nullable(),
  purchasedAt: z.date().nullable(),
});
export type QaLabel = z.infer<typeof QaLabel>;

/** One package row: a line's units in this package, and how many QA has confirmed. */
export const QaRow = z.object({
  id: Id,
  orderItemId: Id,
  name: z.string(),
  sku: z.string().nullable(),
  imageUrl: z.string().nullable(),
  attributes: z.array(LineAttribute),
  quantity: z.number().int(),
  verifiedQuantity: z.number().int(),
  verifiedBy: z.string().nullable(),
  verifiedAt: z.date().nullable(),
  /** Who picked the line and who packed this row, for the order drawer. */
  pickedBy: z.string().nullable(),
  packedBy: z.string().nullable(),
  /** The open Critical issue that names this row's line or package; null when none does. */
  criticalIssueId: Id.nullable(),
});
export type QaRow = z.infer<typeof QaRow>;

export const QaRate = z.object({
  id: Id,
  carrierCode: z.string(),
  serviceName: z.string(),
  amountCents: z.number().int(),
  deliveryDays: z.number().int().nullable(),
  selected: z.boolean(),
  expired: z.boolean(),
});
export type QaRate = z.infer<typeof QaRate>;

export const QaPackage = z.object({
  id: Id,
  number: z.number().int(),
  boxName: z.string().nullable(),
  weightOz: z.number().nullable(),
  rows: z.array(QaRow),
  /** The package's live label, or its latest attempt when none is live. */
  label: QaLabel.nullable(),
  /** Every rate fetched for the package, cheapest first, for the rates table. */
  rates: z.array(QaRate),
  /** The selected rate, for the drawer. */
  selectedRate: z
    .object({ carrierCode: z.string(), serviceName: z.string(), amountCents: z.number().int() })
    .nullable(),
  noteCount: z.number().int(),
});
export type QaPackage = z.infer<typeof QaPackage>;

export const QaPurchase = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("purchasing"), bought: z.number().int(), total: z.number().int() }),
  z.object({ kind: z.literal("failed"), packages: z.array(z.number().int()) }),
]);
export type QaPurchase = z.infer<typeof QaPurchase>;

const Unmet = z.object({
  messageKey: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});

/** What every QA write returns, and the part of the screen that changes with it. */
export const QaResult = z.object({
  packages: z.array(QaPackage),
  /** Open Critical issues that name neither a line nor a package. */
  orderIssueIds: z.array(Id),
  purchase: QaPurchase,
  /** What still stops the order leaving QA; empty when it can. */
  unmet: z.array(Unmet),
});
export type QaResult = z.infer<typeof QaResult>;

export const QaView = QaResult.extend({
  order: OrderDetail,
  customerNote: z.string().nullable(),
});
export type QaView = z.infer<typeof QaView>;

export const SetVerifiedInput = z.object({
  packageItemId: Id,
  /** True verifies the row in full; false clears it. */
  verified: z.boolean(),
  /** A retried tap must not audit twice. */
  idempotencyKey: IdempotencyKey,
});
export type SetVerifiedInput = z.infer<typeof SetVerifiedInput>;

export const SelectRateInput = z.object({ packageId: Id, rateId: Id });
export type SelectRateInput = z.infer<typeof SelectRateInput>;
export const ScanVerifyInput = z.object({
  orderId: Id,
  /** The package the scanner is pointed at: the card the user touched last. */
  packageId: Id,
  /** What the scanner typed: a barcode or SKU, matched like picking's. */
  code: z.string().trim().min(1).max(200),
  /** One per physical scan, so a retried request doesn't count the unit twice. */
  scanId: IdempotencyKey,
});
export type ScanVerifyInput = z.infer<typeof ScanVerifyInput>;

export const VoidLabelInput = z.object({
  labelId: Id,
  reason: z.string().trim().min(1).max(500),
});
export type VoidLabelInput = z.infer<typeof VoidLabelInput>;

export const MarkLabelNotBoughtInput = z.object({
  labelId: Id,
  /** What was checked at the provider; kept in the audit trail. */
  reason: z.string().trim().min(1).max(500),
});
export type MarkLabelNotBoughtInput = z.infer<typeof MarkLabelNotBoughtInput>;

export const qa = {
  screen: base
    .route({
      method: "GET",
      path: "/orders/{orderId}/qa",
      tags,
      summary: "The QA screen: packages, rows with verification, labels and what's still missing",
    })
    .input(z.object({ orderId: Id }))
    .output(QaView),
  setVerified: base
    .route({
      method: "POST",
      path: "/package-items/{packageItemId}/verified",
      tags,
      summary: "Verify a package row in full, or clear it",
    })
    .input(SetVerifiedInput)
    .output(QaResult),
  selectRate: base
    .route({
      method: "POST",
      path: "/packages/{packageId}/rates/{rateId}/select",
      tags,
      summary: "Select another of the package's rates",
    })
    .input(SelectRateInput)
    .output(QaResult),
  scan: base
    .route({
      method: "POST",
      path: "/orders/{orderId}/qa/scan",
      tags,
      summary: "Scan a product in a package: one more verified unit of the first row that needs it",
    })
    .input(ScanVerifyInput)
    .output(QaResult),
  voidLabel: base
    .route({
      method: "POST",
      path: "/labels/{labelId}/void",
      tags,
      summary: "Void a bought label of an order in QA, with a reason",
    })
    .input(VoidLabelInput)
    .output(QaResult),
  markLabelNotBought: base
    .route({
      method: "POST",
      path: "/labels/{labelId}/not-bought",
      tags,
      summary: "Release a purchase nobody could confirm, once the provider has no label for it",
    })
    .input(MarkLabelNotBoughtInput)
    .output(QaResult),
};
