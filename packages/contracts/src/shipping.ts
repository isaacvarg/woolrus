import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";

const tags = ["Shipping"];

/** 6–10 digits, dots allowed on the way in; stored (and returned) without them. */
export const HsCode = z
  .string()
  .trim()
  .regex(/^[\d.]+$/, "errors.shipping.hsCodeInvalid")
  .transform((value) => value.replaceAll(".", ""))
  .pipe(z.string().regex(/^\d{6,10}$/, "errors.shipping.hsCodeInvalid"));

/** ISO 3166-1 alpha-2, upper-cased. */
export const CountryOfOrigin = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, "errors.shipping.countryInvalid"));

export const CustomsDescription = z.string().trim().min(1).max(100);

export const CustomsFilter = z.enum(["all", "missing", "international"]);
export type CustomsFilter = z.infer<typeof CustomsFilter>;

export const CustomsProduct = z.object({
  id: Id,
  name: z.string(),
  sku: z.string().nullable(),
  hsCode: z.string().nullable(),
  countryOfOrigin: z.string().nullable(),
  customsDescription: z.string().nullable(),
  /** Missing an HS code or a country of origin: what stops an international label. */
  missing: z.boolean(),
  /** A line of an open order that ships to another country. */
  onInternationalOrder: z.boolean(),
});
export type CustomsProduct = z.infer<typeof CustomsProduct>;

export const CustomsProductsInput = z.object({
  filter: CustomsFilter.default("all"),
  cursor: z.string().max(500).optional(),
});
export type CustomsProductsInput = z.infer<typeof CustomsProductsInput>;

export const CustomsProductsPage = z.object({
  items: z.array(CustomsProduct),
  nextCursor: z.string().nullable(),
});
export type CustomsProductsPage = z.infer<typeof CustomsProductsPage>;

/** Only the fields present change; `null` clears one. */
export const UpdateProductCustomsInput = z.object({
  productId: Id,
  hsCode: HsCode.nullable().optional(),
  countryOfOrigin: CountryOfOrigin.nullable().optional(),
  customsDescription: CustomsDescription.nullable().optional(),
});
export type UpdateProductCustomsInput = z.infer<typeof UpdateProductCustomsInput>;

/** Exactly one list: whole orders (every active label) or single labels (a reprint). */
export const CreateLabelPrintInput = z
  .object({
    orderIds: z.array(Id).min(1).max(50).optional(),
    labelIds: z.array(Id).min(1).max(20).optional(),
    idempotencyKey: IdempotencyKey,
  })
  .refine((input) => (input.orderIds === undefined) !== (input.labelIds === undefined), {
    message: "errors.validation",
  });
export type CreateLabelPrintInput = z.infer<typeof CreateLabelPrintInput>;

export const LabelPrintResult = z.object({ printId: Id, labelCount: z.number().int() });
export type LabelPrintResult = z.infer<typeof LabelPrintResult>;

/** The Ready queue's print column. */
export const PrintState = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("partial") }),
  z.object({ kind: z.literal("printed"), times: z.number().int() }),
]);
export type PrintState = z.infer<typeof PrintState>;

export const PrintableLabel = z.object({
  id: Id,
  packageNumber: z.number().int(),
  carrierCode: z.string(),
  serviceCode: z.string(),
  trackingNumber: z.string().nullable(),
  printCount: z.number().int(),
  lastPrintedAt: z.date().nullable(),
});
export type PrintableLabel = z.infer<typeof PrintableLabel>;

export const OrderPrintableLabelsInput = z.object({ orderId: Id });
/** The warehouse's calendar day, YYYY-MM-DD. */
export const ShipDate = z.iso.date();

export const ManifestCandidatesInput = z.object({ shipDate: ShipDate });
export type ManifestCandidatesInput = z.infer<typeof ManifestCandidatesInput>;

export const ManifestSummary = z.object({
  id: Id,
  createdAt: z.date(),
  labelCount: z.number().int(),
});
export type ManifestSummary = z.infer<typeof ManifestSummary>;

export const ManifestCarrier = z.object({
  carrierId: Id,
  /** The carrier account as people know it: its label in Settings, else the provider's name. */
  name: z.string(),
  /** Shipped labels of the day that no manifest covers yet. */
  unmanifested: z.number().int(),
  manifests: z.array(ManifestSummary),
});
export type ManifestCarrier = z.infer<typeof ManifestCarrier>;

export const ManifestCandidates = z.object({
  shipDate: ShipDate,
  carriers: z.array(ManifestCarrier),
});
export type ManifestCandidates = z.infer<typeof ManifestCandidates>;

export const CreateManifestInput = z.object({
  carrierId: Id,
  shipDate: ShipDate,
  idempotencyKey: IdempotencyKey,
});
export type CreateManifestInput = z.infer<typeof CreateManifestInput>;

export const CreateManifestResult = z.object({
  manifestId: Id,
  labelCount: z.number().int(),
});
export type CreateManifestResult = z.infer<typeof CreateManifestResult>;

/** Whether an order ships abroad and which products its packages lack customs data for. */
export const OrderCustoms = z.object({
  international: z.boolean(),
  missing: z.array(z.object({ package: z.number().int(), products: z.array(z.string()) })),
});
export type OrderCustoms = z.infer<typeof OrderCustoms>;

export const OrderCustomsInput = z.object({ orderId: Id });
export type OrderCustomsInput = z.infer<typeof OrderCustomsInput>;

export const ShipOrdersInput = z.object({
  orderIds: z.array(Id).min(1).max(50),
  /** Set after the UI asked about never-printed labels. */
  confirmUnprinted: z.boolean().default(false),
  idempotencyKey: IdempotencyKey,
});
export type ShipOrdersInput = z.infer<typeof ShipOrdersInput>;

export const ShipOrderResult = z.discriminatedUnion("ok", [
  z.object({ orderId: Id, orderNumber: z.string(), ok: z.literal(true) }),
  z.object({
    orderId: Id,
    orderNumber: z.string(),
    ok: z.literal(false),
    messageKey: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number()])),
  }),
]);
export type ShipOrderResult = z.infer<typeof ShipOrderResult>;

export const ShipOrdersResult = z.object({ results: z.array(ShipOrderResult) });
export type ShipOrdersResult = z.infer<typeof ShipOrdersResult>;

/** A label of an order that could not be voided, with why. */
export const RepackBlockedLabel = z.object({
  labelId: Id,
  packageNumber: z.number().int(),
  status: z.string(),
  /** An error code (`errors.…`) the client translates. */
  error: z.string().nullable(),
});
export type RepackBlockedLabel = z.infer<typeof RepackBlockedLabel>;

export const RepackInput = z
  .object({
    orderIds: z.array(Id).min(1).max(10),
    reason: z.string().trim().min(1).max(500),
    issueId: Id.optional(),
    idempotencyKey: IdempotencyKey,
  })
  .refine((input) => input.issueId === undefined || input.orderIds.length === 1, {
    message: "errors.validation",
  });
export type RepackInput = z.infer<typeof RepackInput>;

export const RepackOrderResult = z.object({
  orderId: Id,
  /** The order is back in Packing. */
  repacked: z.boolean(),
  /** Why the order was refused outright (`errors.…`), when it was. */
  error: z.string().nullable(),
  /** Labels still live at their provider when the repack stopped. */
  blocked: z.array(RepackBlockedLabel),
});
export type RepackOrderResult = z.infer<typeof RepackOrderResult>;

export const RepackResult = z.object({ orders: z.array(RepackOrderResult) });
export type RepackResult = z.infer<typeof RepackResult>;

export const RetryVoidInput = z.object({ labelId: Id });
export type RetryVoidInput = z.infer<typeof RetryVoidInput>;

export const WriteOffLabelInput = z.object({
  labelId: Id,
  reason: z.string().trim().min(1).max(500),
});
export type WriteOffLabelInput = z.infer<typeof WriteOffLabelInput>;

/** Where a stuck label ended up after a retry or a write-off. */
export const LabelVoidStep = z.object({
  orderId: Id,
  status: z.enum(["VOIDED", "VOID_REJECTED", "WRITTEN_OFF"]),
});
export type LabelVoidStep = z.infer<typeof LabelVoidStep>;

/** A label whose void was rejected or never answered, waiting for a retry or a write-off. */
export const StuckLabel = z.object({
  id: Id,
  packageNumber: z.number().int(),
  status: z.enum(["VOID_REJECTED", "VOID_REQUESTED"]),
  /** An error code (`errors.…`) the client translates. */
  error: z.string().nullable(),
  voidReason: z.string().nullable(),
});
export type StuckLabel = z.infer<typeof StuckLabel>;

export const StuckLabels = z.object({
  labels: z.array(StuckLabel),
  /** The caller holds `label.writeOff`, so the screen offers it. */
  canWriteOff: z.boolean(),
});
export type StuckLabels = z.infer<typeof StuckLabels>;

export const StuckLabelsInput = z.object({ orderId: Id });

export const shipping = {
  createLabelPrint: base
    .route({
      method: "POST",
      path: "/label-prints",
      tags,
      summary: "Record a print of labels; the PDF is fetched from /api/label-prints/{id}.pdf",
    })
    .input(CreateLabelPrintInput)
    .output(LabelPrintResult),

  shipOrders: base
    .route({
      method: "POST",
      path: "/orders/ship",
      tags,
      summary: "Ship Ready orders (Ready → Completed), each in its own transaction",
    })
    .input(ShipOrdersInput)
    .output(ShipOrdersResult),

  orderPrintableLabels: base
    .route({
      method: "GET",
      path: "/orders/{orderId}/printable-labels",
      tags,
      summary: "An order's active labels with their print counts",
    })
    .input(OrderPrintableLabelsInput)
    .output(z.array(PrintableLabel)),
  orderCustoms: base
    .route({
      method: "GET",
      path: "/orders/{orderId}/customs",
      tags,
      summary: "Whether an order is international and what customs data its packages lack",
    })
    .input(OrderCustomsInput)
    .output(OrderCustoms),

  repack: base
    .route({
      method: "POST",
      path: "/orders/repack",
      tags,
      summary: "Void the labels of Ready orders and send them back to Packing",
    })
    .input(RepackInput)
    .output(RepackResult),

  retryVoid: base
    .route({
      method: "POST",
      path: "/labels/{labelId}/retry-void",
      tags,
      summary: "Ask the provider again to void a label stuck in Ready",
    })
    .input(RetryVoidInput)
    .output(LabelVoidStep),

  writeOffLabel: base
    .route({
      method: "POST",
      path: "/labels/{labelId}/write-off",
      tags,
      summary: "Write off a label the provider won't void (admin, after checking the carrier)",
    })
    .input(WriteOffLabelInput)
    .output(LabelVoidStep),

  stuckLabels: base
    .route({
      method: "GET",
      path: "/orders/{orderId}/stuck-labels",
      tags,
      summary: "An order's labels waiting for a retry or a write-off",
    })
    .input(StuckLabelsInput)
    .output(StuckLabels),

  customsProducts: base
    .route({
      method: "GET",
      path: "/products/customs",
      tags,
      summary: "List products with their customs data",
    })
    .input(CustomsProductsInput)
    .output(CustomsProductsPage),

  updateProductCustoms: base
    .route({
      method: "PATCH",
      path: "/products/{productId}/customs",
      tags,
      summary: "Edit a product's customs data",
    })
    .input(UpdateProductCustomsInput)
    .output(CustomsProduct),

  manifestCandidates: base
    .route({
      method: "GET",
      path: "/manifests/candidates",
      tags,
      summary: "Per carrier account, the day's shipped labels without a manifest",
    })
    .input(ManifestCandidatesInput)
    .output(ManifestCandidates),

  createManifest: base
    .route({
      method: "POST",
      path: "/manifests",
      tags,
      summary: "Manifest a carrier account's shipped labels for a day",
    })
    .input(CreateManifestInput)
    .output(CreateManifestResult),
};
