import { describe, expect, it } from "vitest";
import inventoryTypes from "./__fixtures__/inventory-types.json" with { type: "json" };
import itemTypes from "./__fixtures__/item-types.json" with { type: "json" };
import items from "./__fixtures__/items.json" with { type: "json" };
import lots from "./__fixtures__/lots.json" with { type: "json" };
import procurementTypes from "./__fixtures__/procurement-types.json" with { type: "json" };
import type { LumexiaClient } from "./client";
import { LumexiaAuthError, LumexiaUnavailable } from "./errors";
import type { RawLumexiaItem, RawLumexiaLot, RawLumexiaType } from "./schemas";

// What every LumexiaClient must do (SPEC-lumexia success criterion 1), run against the fake and
// against the HTTP client over a server answering in the documented shapes, so the fake can't
// drift from the real client.

/** Everything Lumexia holds, as it sends it. */
export type LumexiaWorld = {
  itemTypes: RawLumexiaType[];
  procurementTypes: RawLumexiaType[];
  inventoryTypes: RawLumexiaType[];
  items: RawLumexiaItem[];
  lots: RawLumexiaLot[];
};

/** The fixtures' records, which every contract test reads. */
export const contractWorld = (): LumexiaWorld =>
  structuredClone({
    itemTypes: itemTypes.itemTypes,
    procurementTypes: procurementTypes.procurementTypes,
    inventoryTypes: inventoryTypes.inventoryTypes,
    items: items.items,
    lots: lots.lots,
  });

/** A failure of the client's transport: an HTTP status, a network error or a timeout. */
export type SimulatedFailure = 400 | 401 | 403 | 429 | 500 | 503 | "network" | "timeout";

export type LumexiaFixture = {
  client: LumexiaClient;
  /** Makes the client's next request fail the way its transport would. */
  failNext(failure: SimulatedFailure): void;
  /** Credential values, which must never appear in an error. */
  secrets: string[];
};

const LAVENDER = "0193f0a1-0000-7000-8000-000000000101";
const ROSE = "0193f0a1-0000-7000-8000-000000000102";
const BOX = "0193f0a1-0000-7000-8000-000000000103";
const UNKNOWN = "0193f0a1-0000-7000-8000-00000000ffff";

const expectedFailures: [SimulatedFailure, unknown][] = [
  [401, LumexiaAuthError],
  [403, LumexiaAuthError],
  [429, LumexiaUnavailable],
  [500, LumexiaUnavailable],
  [503, LumexiaUnavailable],
  ["network", LumexiaUnavailable],
  ["timeout", LumexiaUnavailable],
];

export function describeLumexiaClient(
  name: string,
  setup: (world: LumexiaWorld) => LumexiaFixture,
) {
  describe(`${name} (LumexiaClient contract)`, () => {
    const fixture = () => setup(contractWorld());

    it("pings", async () => {
      await expect(fixture().client.ping()).resolves.toBeUndefined();
    });

    it("lists every type of each kind, with isTracked on inventory types only", async () => {
      const { client } = fixture();
      const item = await client.listTypes("item");
      expect(item.map((t) => t.name)).toEqual(["Production base", "Finished good", "Packaging"]);
      expect(item[0]).toEqual({
        id: "0193f0a1-0000-7000-8000-000000000001",
        name: "Production base",
        archived: false,
      });
      expect((await client.listTypes("procurement")).map((t) => t.name)).toEqual([
        "Manufactured",
        "Purchased",
      ]);
      expect(await client.listTypes("inventory")).toEqual([
        expect.objectContaining({ name: "Lot tracked", isTracked: true }),
        expect.objectContaining({ name: "Untracked", isTracked: false }),
      ]);
    });

    it("gets an item with its types and a Date, or null", async () => {
      const { client } = fixture();
      expect(await client.getItem(LAVENDER)).toEqual({
        id: LAVENDER,
        referenceCode: "BASE1234",
        name: "Lavender base, 1 gal",
        aliases: ["4417", "LAV-BASE-1G"],
        itemTypeId: "0193f0a1-0000-7000-8000-000000000001",
        procurementTypeId: "0193f0a1-0000-7000-8000-000000000011",
        inventoryTypeId: "0193f0a1-0000-7000-8000-000000000021",
        archived: false,
        updatedAt: new Date("2026-11-09T14:03:00.000Z"),
      });
      expect(await client.getItem(BOX)).toMatchObject({ archived: true, itemTypeId: null });
      expect(await client.getItem(UNKNOWN)).toBeNull();
    });

    it("searches name, reference code and alias, case-insensitively, up to the limit", async () => {
      const { client } = fixture();
      const ids = async (q: string, limit?: number) =>
        (await client.searchItems(q, limit)).map((i) => i.id);
      expect(await ids("lavender")).toEqual([LAVENDER]);
      expect(await ids("base9")).toEqual([ROSE]);
      expect(await ids("box-small")).toEqual([BOX]);
      expect(await ids("base")).toEqual([LAVENDER, ROSE]);
      expect(await ids("base", 1)).toEqual([LAVENDER]);
      expect(await ids("nothing like it")).toEqual([]);
    });

    it("finds items by reference code or alias, and by id", async () => {
      const { client } = fixture();
      const ids = async (filter: Parameters<LumexiaClient["findItems"]>[0]) =>
        (await client.findItems(filter)).map((i) => i.id).sort();
      expect(await ids({ referenceCodes: ["base1234"] })).toEqual([LAVENDER]);
      expect(await ids({ referenceCodes: ["LAV-BASE-1G", "BASE9999", "NOPE"] })).toEqual([
        LAVENDER,
        ROSE,
      ]);
      // A code and an alias of the same item: it comes back once.
      expect(await ids({ referenceCodes: ["BASE1234", "lav-base-1g"] })).toEqual([LAVENDER]);
      expect(await ids({ ids: [ROSE, BOX, UNKNOWN] })).toEqual([ROSE, BOX].sort());
      expect(await ids({ referenceCodes: [] })).toEqual([]);
      expect(await ids({ ids: [UNKNOWN] })).toEqual([]);
    });

    it("gets a lot by id, or null", async () => {
      const { client } = fixture();
      expect(await client.getLot("0193f0a1-0000-7000-8000-000000000201")).toEqual({
        id: "0193f0a1-0000-7000-8000-000000000201",
        itemId: LAVENDER,
        lotNumber: "BASE1234.A12A0124",
        archived: false,
        createdAt: new Date("2024-01-01T09:00:00.000Z"),
      });
      expect(await client.getLot(UNKNOWN)).toBeNull();
    });

    it("finds every lot with a number, on any item, case-insensitively", async () => {
      const { client } = fixture();
      const found = await client.findLotsByNumber("base1234.a12a0124");
      expect(found.map((l) => l.itemId).sort()).toEqual([LAVENDER, ROSE]);
      expect(await client.findLotsByNumber("BASE1234.B07C1124")).toHaveLength(1);
      expect(await client.findLotsByNumber("BASE1234.Z99L3199")).toEqual([]);
    });

    describe("failures", () => {
      for (const [failure, type] of expectedFailures) {
        it(`maps ${failure} to ${(type as { name: string }).name}, without the key`, async () => {
          const { client, failNext, secrets } = fixture();
          failNext(failure);
          const error = await client.getItem(LAVENDER).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(type);
          const text = `${(error as Error).message} ${JSON.stringify(error)}`;
          for (const secret of secrets) expect(text).not.toContain(secret);
        });
      }

      it("throws a 400 as an internal error, not a Lumexia failure", async () => {
        const { client, failNext } = fixture();
        failNext(400);
        const error = await client.listTypes("item").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(LumexiaUnavailable);
        expect(error).not.toBeInstanceOf(LumexiaAuthError);
      });

      it("fails only the next request", async () => {
        const { client, failNext } = fixture();
        failNext(500);
        await expect(client.ping()).rejects.toBeInstanceOf(LumexiaUnavailable);
        await expect(client.ping()).resolves.toBeUndefined();
      });
    });
  });
}
