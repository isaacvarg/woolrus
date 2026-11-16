import type { Prisma } from "@woolrus/db";
import { nameFields } from "../workflow/people";

// An order line as picking, packing and the packing checks read it. Kept in its own module so the
// workflow gates can evaluate packing checks without importing picking/service, which imports them.

export const lineInclude = {
  product: {
    select: {
      physical: true,
      binLocation: true,
      barcode: true,
      sku: true,
      weightOz: true,
      lengthIn: true,
      widthIn: true,
      heightIn: true,
    },
  },
  variation: {
    select: {
      binLocation: true,
      barcode: true,
      sku: true,
      weightOz: true,
      lengthIn: true,
      widthIn: true,
      heightIn: true,
    },
  },
  voids: { where: { undoneAt: null }, select: { quantity: true } },
  pickedBy: { select: nameFields },
} as const satisfies Prisma.OrderItemInclude;

export type LineRow = Prisma.OrderItemGetPayload<{ include: typeof lineInclude }>;
