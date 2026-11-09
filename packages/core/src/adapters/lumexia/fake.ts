import type { LumexiaClient, LumexiaItemFilter, LumexiaTypeKind } from "./client";
import { LumexiaAuthError, LumexiaUnavailable } from "./errors";
import {
  type LumexiaItem,
  type LumexiaLot,
  type LumexiaType,
  parseLumexiaItem,
  parseLumexiaLot,
  parseLumexiaType,
  type RawLumexiaItem,
  type RawLumexiaLot,
  type RawLumexiaType,
} from "./schemas";

// In-memory Lumexia for core tests and for dev without a Lumexia running. It keeps records as
// Lumexia sends them and answers through the HTTP client's schemas, so a record the real client
// couldn't parse fails here too. Filters match docs/lumexia-api.md; `matchItems` and `matchLots`
// are shared with the HTTP contract test's server.

type Method = Exclude<keyof LumexiaClient, symbol>;

/** A transport failure, as `contract.ts` simulates it. */
export type FakeLumexiaFailure = 400 | 401 | 403 | 429 | 500 | 503 | "network" | "timeout";

export type FakeLumexiaWorld = {
  itemTypes?: RawLumexiaType[];
  procurementTypes?: RawLumexiaType[];
  inventoryTypes?: RawLumexiaType[];
  items?: RawLumexiaItem[];
  lots?: RawLumexiaLot[];
};

const UPDATED_AT = "2026-11-01T12:00:00.000Z";
const SEARCH_LIMIT = 50;
const MAX_LIMIT = 200;

const lower = (s: string) => s.toLowerCase();

/** `GET /items` filters: `q` contains on name, code or alias; codes exact on code or alias; ids exact. */
export function matchItems(
  items: readonly RawLumexiaItem[],
  filter: { q?: string; referenceCodes?: readonly string[]; ids?: readonly string[] },
): RawLumexiaItem[] {
  const q = filter.q === undefined ? undefined : lower(filter.q);
  const codes = filter.referenceCodes && new Set(filter.referenceCodes.map(lower));
  const ids = filter.ids && new Set(filter.ids);
  return items.filter((item) => {
    const names = [item.referenceCode, ...item.aliases].map(lower);
    if (q !== undefined && ![lower(item.name), ...names].some((n) => n.includes(q))) return false;
    if (codes && !names.some((n) => codes.has(n))) return false;
    if (ids && !ids.has(item.id)) return false;
    return true;
  });
}

/** `GET /lots` filters: the number exact and case-insensitive, optionally one item. */
export function matchLots(
  lots: readonly RawLumexiaLot[],
  filter: { lotNumber?: string; itemId?: string },
): RawLumexiaLot[] {
  return lots.filter(
    (lot) =>
      (filter.lotNumber === undefined || lower(lot.lotNumber) === lower(filter.lotNumber)) &&
      (filter.itemId === undefined || lot.itemId === filter.itemId),
  );
}

export function fakeLumexiaError(failure: FakeLumexiaFailure): Error {
  const detail = `fake Lumexia: ${failure}`;
  if (failure === 401 || failure === 403) return new LumexiaAuthError(detail, failure);
  if (failure === 400) return new Error(`${detail} invalid_request`);
  return new LumexiaUnavailable(
    `${detail} (unavailable)`,
    typeof failure === "number" ? failure : undefined,
  );
}

export class FakeLumexiaClient implements LumexiaClient {
  readonly calls: { method: Method; args: unknown[] }[] = [];

  #types: Record<LumexiaTypeKind, RawLumexiaType[]>;
  #items: RawLumexiaItem[];
  #lots: RawLumexiaLot[];
  #failures: FakeLumexiaFailure[] = [];
  #down = false;

  constructor(world: FakeLumexiaWorld = {}) {
    this.#types = {
      item: [...(world.itemTypes ?? [])],
      procurement: [...(world.procurementTypes ?? [])],
      inventory: [...(world.inventoryTypes ?? [])],
    };
    this.#items = [...(world.items ?? [])];
    this.#lots = [...(world.lots ?? [])];
  }

  /** The next call fails this way (queued: several calls fail in order). */
  failNext(failure: FakeLumexiaFailure): void {
    this.#failures.push(failure);
  }

  /** While down, every call throws `LumexiaUnavailable`. */
  setDown(down: boolean): void {
    this.#down = down;
  }

  addType(
    kind: LumexiaTypeKind,
    fields: Partial<{ id: string; name: string; isTracked: boolean }> = {},
  ): LumexiaType {
    const raw: RawLumexiaType = {
      id: fields.id ?? crypto.randomUUID(),
      name: fields.name ?? `${kind} type ${this.#types[kind].length + 1}`,
      archived: false,
      ...(kind === "inventory" ? { isTracked: fields.isTracked ?? false } : {}),
    };
    this.#types[kind].push(raw);
    return parseLumexiaType(raw, kind === "inventory");
  }

  addItem(fields: Partial<RawLumexiaItem> & { referenceCode: string }): LumexiaItem {
    const raw: RawLumexiaItem = {
      id: crypto.randomUUID(),
      name: fields.referenceCode,
      aliases: [],
      itemTypeId: null,
      procurementTypeId: null,
      inventoryTypeId: null,
      archived: false,
      updatedAt: UPDATED_AT,
      ...fields,
    };
    this.#items.push(raw);
    return parseLumexiaItem(raw);
  }

  addLot(fields: Partial<RawLumexiaLot> & { itemId: string; lotNumber: string }): LumexiaLot {
    const raw: RawLumexiaLot = {
      id: crypto.randomUUID(),
      archived: false,
      createdAt: UPDATED_AT,
      ...fields,
    };
    this.#lots.push(raw);
    return parseLumexiaLot(raw);
  }

  async ping(): Promise<void> {
    this.#enter("ping", []);
  }

  async listTypes(kind: LumexiaTypeKind): Promise<LumexiaType[]> {
    this.#enter("listTypes", [kind]);
    return this.#types[kind].map((t) => parseLumexiaType(t, kind === "inventory"));
  }

  async searchItems(q: string, limit = SEARCH_LIMIT): Promise<LumexiaItem[]> {
    this.#enter("searchItems", [q, limit]);
    const capped = Math.min(Math.max(limit, 1), MAX_LIMIT);
    return matchItems(this.#items, { q }).slice(0, capped).map(parseLumexiaItem);
  }

  async findItems(filter: LumexiaItemFilter): Promise<LumexiaItem[]> {
    this.#enter("findItems", [filter]);
    const values = "ids" in filter ? filter.ids : filter.referenceCodes;
    if (values.length === 0) return [];
    return matchItems(this.#items, filter).map(parseLumexiaItem);
  }

  async getItem(id: string): Promise<LumexiaItem | null> {
    this.#enter("getItem", [id]);
    const raw = this.#items.find((i) => i.id === id);
    return raw ? parseLumexiaItem(raw) : null;
  }

  async getLot(id: string): Promise<LumexiaLot | null> {
    this.#enter("getLot", [id]);
    const raw = this.#lots.find((l) => l.id === id);
    return raw ? parseLumexiaLot(raw) : null;
  }

  async findLotsByNumber(lotNumber: string): Promise<LumexiaLot[]> {
    this.#enter("findLotsByNumber", [lotNumber]);
    return matchLots(this.#lots, { lotNumber }).map(parseLumexiaLot);
  }

  #enter(method: Method, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.#down) throw new LumexiaUnavailable("fake Lumexia: down (unavailable)");
    const failure = this.#failures.shift();
    if (failure !== undefined) throw fakeLumexiaError(failure);
  }
}
