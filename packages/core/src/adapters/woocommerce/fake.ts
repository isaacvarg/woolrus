import { toCents } from "../../units";
import type { DimensionUnit, ListOrdersQuery, StoreAdapter, WeightUnit } from "./adapter";
import type { StoreError } from "./errors";
import {
  parseOrder,
  parseProduct,
  parseVariation,
  type WooOrder,
  type WooProduct,
  type WooVariation,
} from "./schemas";

// In-memory WooCommerce for core tests. It keeps raw REST JSON (snake_case, as the store sends it)
// and answers through the same schemas as the HTTP adapter, with the same paging (100 per page,
// newest first, at least one page). Every change moves its clock one second forward and stamps
// `date_modified_gmt`, so `modifiedAfter` behaves like the real store's.

type Json = Record<string, unknown>;

/** A line item. `id` keeps an existing line on edit; `product: 0` is a product deleted in the store. */
export type FakeLineInput = {
  id?: number;
  product?: number;
  variation?: number;
  quantity?: number;
  price?: string;
  name?: string;
  sku?: string;
} & Json;

/** Any raw order field (`customer_note`, `shipping`, `shipping_lines`…), plus `lines`. */
export type FakeOrderInput = { status?: string; lines?: FakeLineInput[] } & Json;

export type FakeProductInput = { variations?: Json[] } & Json;

type Method = Exclude<keyof StoreAdapter, symbol>;

const PER_PAGE = 100;
const START = new Date("2026-10-01T12:00:00Z");

export class FakeStoreAdapter implements StoreAdapter {
  readonly calls: { method: Method; args: unknown[] }[] = [];
  units: { weight: WeightUnit; dimension: DimensionUnit };

  #clock = START.getTime();
  #nextId = 1000;
  #nextLineId = 1;
  #orders = new Map<number, Json>();
  #products = new Map<number, Json>();
  #variations = new Map<number, Json[]>();
  #failures: { method: Method; error: StoreError }[] = [];
  #defaultProductId: number | null = null;

  constructor(options: { units?: { weight: WeightUnit; dimension: DimensionUnit } } = {}) {
    this.units = options.units ?? { weight: "lbs", dimension: "in" };
  }

  /** The store's clock: the timestamp the last change was stamped with. */
  now(): Date {
    return new Date(this.#clock);
  }

  /** Makes the next `times` calls of `method` throw `error`. */
  failNext(method: Method, error: StoreError, times = 1): void {
    for (let i = 0; i < times; i++) this.#failures.push({ method, error });
  }

  // ---- Store-side changes --------------------------------------------------------------------

  /** A `processing` order with one line of a default product unless `lines` says otherwise. */
  addOrder(input: FakeOrderInput = {}): WooOrder {
    const { lines = [{}], ...fields } = input;
    const id = this.#nextId++;
    const at = this.#tick();
    const customer = {
      first_name: "Test",
      last_name: "Customer",
      company: "",
      address_1: "1 Main St",
      address_2: "",
      city: "Austin",
      state: "TX",
      postcode: "78701",
      country: "US",
      phone: "",
    };
    const order: Json = {
      id,
      number: String(id),
      status: "processing",
      currency: "USD",
      customer_note: "",
      payment_method_title: "Credit card",
      date_created_gmt: at,
      billing: { ...customer, email: "customer@example.test" },
      shipping: customer,
      shipping_lines: [{ method_title: "Flat rate", total: "5.00" }],
      refunds: [],
      meta_data: [],
      ...fields,
      line_items: lines.map((line) => this.#line(line)),
      date_modified_gmt: at,
    };
    if (fields.total === undefined) order.total = orderTotal(order);
    this.#orders.set(id, order);
    return parseOrder(structuredClone(order));
  }

  /** Merges raw fields into the order. `lines` replaces the line items (keep one by its `id`). */
  editOrder(id: number, patch: FakeOrderInput): WooOrder {
    const order = this.#order(id);
    const { lines, ...fields } = patch;
    Object.assign(order, fields);
    if (lines) {
      const existing = new Map((order.line_items as Json[]).map((l) => [l.id, l]));
      order.line_items = lines.map((line) => {
        const current = line.id === undefined ? undefined : existing.get(line.id);
        return current ? this.#editLine(current, line) : this.#line(line);
      });
      if (fields.total === undefined) order.total = orderTotal(order);
    }
    order.date_modified_gmt = this.#tick();
    return parseOrder(structuredClone(order));
  }

  cancelOrder(id: number): WooOrder {
    return this.editOrder(id, { status: "cancelled" });
  }

  /** Refunds `amount` (default: what's left); refunding everything sets status `refunded`. */
  refundOrder(id: number, amount?: string): WooOrder {
    const order = this.#order(id);
    const refunds = order.refunds as Json[];
    const refunded = refunds.reduce((sum, r) => sum - toCents(r.total as string), 0);
    const left = toCents(order.total as string) - refunded;
    const cents = amount === undefined ? left : toCents(amount);
    const refund = { id: this.#nextId++, reason: "", total: formatCents(-cents) };
    return this.editOrder(id, {
      refunds: [...refunds, refund],
      ...(cents >= left ? { status: "refunded" } : {}),
    });
  }

  /** A simple product unless `type` says otherwise; `variations` are raw variation fields. */
  addProduct(input: FakeProductInput = {}): WooProduct {
    const { variations = [], ...fields } = input;
    const id = this.#nextId++;
    const product: Json = {
      id,
      type: "simple",
      name: `Product ${id}`,
      sku: `SKU-${id}`,
      price: "10.00",
      weight: "0.5",
      dimensions: { length: "4", width: "3", height: "2" },
      stock_quantity: 100,
      virtual: false,
      global_unique_id: "",
      images: [],
      meta_data: [],
      date_created_gmt: this.#tick(),
      ...fields,
    };
    const children = variations.map((v) => ({
      id: this.#nextId++,
      name: "",
      sku: "",
      price: product.price,
      weight: "",
      dimensions: { length: "", width: "", height: "" },
      stock_quantity: null,
      virtual: false,
      global_unique_id: "",
      image: null,
      attributes: [],
      meta_data: [],
      parent_id: id,
      ...v,
    }));
    product.variations = children.map((v) => v.id);
    this.#products.set(id, product);
    this.#variations.set(id, children);
    return parseProduct(structuredClone(product));
  }

  /** Changes raw product fields; `variations` replaces a variation's fields by id. */
  editProduct(id: number, input: FakeProductInput): WooProduct {
    const product = this.#products.get(id);
    if (!product) throw new Error(`FakeStoreAdapter: no product ${id}`);
    const { variations, ...fields } = input;
    Object.assign(product, fields);
    for (const patch of variations ?? []) {
      const child = this.#variations.get(id)?.find((v) => v.id === patch.id);
      if (child) Object.assign(child, patch);
    }
    return parseProduct(structuredClone(product));
  }

  /** Deletes a product (and its variations) from the store. */
  removeProduct(id: number): void {
    this.#products.delete(id);
    this.#variations.delete(id);
  }

  // ---- StoreAdapter --------------------------------------------------------------------------

  async ping(): Promise<void> {
    this.#call("ping");
  }

  async getUnits() {
    this.#call("getUnits");
    return { ...this.units };
  }

  async listOrders(q: ListOrdersQuery) {
    this.#call("listOrders", q);
    const matching = [...this.#orders.values()]
      .filter(
        (o) =>
          (!q.status || o.status === q.status) &&
          (!q.modifiedAfter || gmtDate(o.date_modified_gmt) > q.modifiedAfter) &&
          (!q.include || q.include.includes(o.id as number)),
      )
      .sort(newestFirst);
    return {
      orders: page(matching, q.page).map((o) => parseOrder(structuredClone(o))),
      totalPages: pageCount(matching),
    };
  }

  async getOrder(id: number): Promise<WooOrder | null> {
    this.#call("getOrder", id);
    const order = this.#orders.get(id);
    return order ? parseOrder(structuredClone(order)) : null;
  }

  async getProducts(ids: number[]): Promise<WooProduct[]> {
    this.#call("getProducts", ids);
    return [...this.#products.values()]
      .filter((p) => ids.includes(p.id as number))
      .sort(newestFirst)
      .map((p) => parseProduct(structuredClone(p)));
  }

  async listProducts(n: number) {
    this.#call("listProducts", n);
    const all = [...this.#products.values()].sort(newestFirst);
    return {
      products: page(all, n).map((p) => parseProduct(structuredClone(p))),
      totalPages: pageCount(all),
    };
  }

  async listVariations(productId: number): Promise<WooVariation[]> {
    this.#call("listVariations", productId);
    return (this.#variations.get(productId) ?? []).map((v) => parseVariation(structuredClone(v)));
  }

  // ---- Internals -----------------------------------------------------------------------------

  #call(method: Method, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const index = this.#failures.findIndex((f) => f.method === method);
    const [failure] = index >= 0 ? this.#failures.splice(index, 1) : [];
    if (failure) throw failure.error;
  }

  #tick(): string {
    this.#clock += 1000;
    return new Date(this.#clock).toISOString().slice(0, 19);
  }

  #order(id: number): Json {
    const order = this.#orders.get(id);
    if (!order) throw new Error(`FakeStoreAdapter: no order ${id}`);
    return order;
  }

  /** A new line, named and priced from its product (and variation) like WooCommerce does. */
  #line(input: FakeLineInput): Json {
    const { id, product: productId = this.#defaultProduct(), variation, ...fields } = input;
    const product = this.#products.get(productId);
    const child = this.#variations.get(productId)?.find((v) => v.id === variation);
    const source = child ?? product;
    const line: Json = {
      id: id ?? this.#nextLineId++,
      name: [product?.name ?? `Deleted product`, child?.name].filter(Boolean).join(" - "),
      product_id: productId,
      variation_id: child ? child.id : 0,
      quantity: 1,
      sku: source?.sku ?? "",
      price: source?.price ?? "10.00",
      image: { id: "", src: "" },
      meta_data: [],
      ...fields,
    };
    return withLineTotal(line);
  }

  #editLine(current: Json, input: FakeLineInput): Json {
    const { id: _id, product: _product, variation: _variation, ...fields } = input;
    return withLineTotal({ ...current, ...fields });
  }

  #defaultProduct(): number {
    this.#defaultProductId ??= this.addProduct({ name: "Fake Product", sku: "FAKE" }).id;
    return this.#defaultProductId;
  }
}

/** Woo sends line `price` as a JSON number and `total` as a string. */
function withLineTotal(line: Json): Json {
  const price = String(line.price);
  return {
    ...line,
    price: Number(price),
    total: formatCents(toCents(price) * (line.quantity as number)),
  };
}

function orderTotal(order: Json): string {
  const sum = (rows: Json[]) => rows.reduce((s, r) => s + toCents(String(r.total)), 0);
  return formatCents(sum(order.line_items as Json[]) + sum(order.shipping_lines as Json[]));
}

function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function gmtDate(value: unknown): Date {
  return new Date(`${value as string}Z`);
}

function newestFirst(a: Json, b: Json): number {
  return (
    gmtDate(b.date_created_gmt).getTime() - gmtDate(a.date_created_gmt).getTime() ||
    (b.id as number) - (a.id as number)
  );
}

function page<T>(rows: T[], n: number): T[] {
  return rows.slice((n - 1) * PER_PAGE, n * PER_PAGE);
}

function pageCount(rows: unknown[]): number {
  return Math.max(1, Math.ceil(rows.length / PER_PAGE));
}
