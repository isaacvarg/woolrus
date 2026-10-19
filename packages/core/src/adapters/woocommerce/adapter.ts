import type { DimensionUnit, WeightUnit } from "../../units";
import type { WooOrder, WooProduct, WooVariation } from "./schemas";

export { type DimensionUnit, dimensionUnits, type WeightUnit, weightUnits } from "../../units";

export type {
  WooAddress,
  WooLineItem,
  WooMeta,
  WooOrder,
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
}
