import type { DimensionUnit, WeightUnit } from "../../units";
import type { WooOrder, WooOrderNote, WooProduct, WooVariation } from "./schemas";

export { type DimensionUnit, dimensionUnits, type WeightUnit, weightUnits } from "../../units";

export type {
  WooAddress,
  WooLineItem,
  WooMeta,
  WooOrder,
  WooOrderNote,
  WooProduct,
  WooVariation,
} from "./schemas";

export type ListOrdersQuery = {
  status?: "processing";
  modifiedAfter?: Date;
  include?: number[];
  page: number;
};

/**
 * Everything sync needs from WooCommerce (REST v3). Every method throws `StoreError`. Sync
 * services take this as an argument: `createStoreAdapter` for the real store, the fake in tests.
 */
export interface StoreAdapter {
  /** Succeeds when the URL is a WooCommerce store and the keys can read orders. */
  ping(): Promise<void>;
  getUnits(): Promise<{ weight: WeightUnit; dimension: DimensionUnit }>;
  listOrders(q: ListOrdersQuery): Promise<{ orders: WooOrder[]; totalPages: number }>;
  /** null when the store has no such order. */
  getOrder(id: number): Promise<WooOrder | null>;
  /** By id with `include=`, in batches of 100. Ids the store doesn't have are just missing. */
  getProducts(ids: number[]): Promise<WooProduct[]>;
  listProducts(page: number): Promise<{ products: WooProduct[]; totalPages: number }>;
  /** Every variation of a variable product, all pages. */
  listVariations(productId: number): Promise<WooVariation[]>;
  /** Every note of the order, all pages. Throws `notFound` for an order the store doesn't have. */
  listOrderNotes(orderId: number): Promise<WooOrderNote[]>;
  /** One order note. A customer note is emailed by WooCommerce; the text goes as plain text. */
  addOrderNote(
    orderId: number,
    note: { note: string; customerNote: boolean },
  ): Promise<{ noteId: number }>;
  /** Sets the order Completed; WooCommerce treats a repeat as a no-op. */
  completeOrder(orderId: number): Promise<void>;
}
