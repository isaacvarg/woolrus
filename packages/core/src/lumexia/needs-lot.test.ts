import { describe, expect, it } from "vitest";
import { type LotRuleProduct, type LotRuleSettings, needsLot } from "./rules";

// SPEC-lumexia success criterion 3: the table of cases for `needsLot`.

const ITEM = "0190a000-0000-7000-8000-000000000001";
const PROCUREMENT = "0190a000-0000-7000-8000-000000000002";
const INVENTORY = "0190a000-0000-7000-8000-000000000003";
const OTHER = "0190a000-0000-7000-8000-000000000009";

const linked: LotRuleProduct = {
  physical: true,
  lumexiaItemId: "item-1",
  lumexiaItemTypeId: ITEM,
  lumexiaProcurementTypeId: PROCUREMENT,
  lumexiaInventoryTypeId: INVENTORY,
  lotOverride: null,
};

const none: LotRuleSettings = {
  lumexiaLotItemTypeIds: [],
  lumexiaLotProcurementTypeIds: [],
  lumexiaLotInventoryTypeIds: [],
};
const only = (field: keyof LotRuleSettings, ids: string[]): LotRuleSettings => ({
  ...none,
  [field]: ids,
});

describe("needsLot", () => {
  it.each<[string, Partial<LotRuleProduct>, LotRuleSettings, boolean]>([
    ["no type switched on", {}, none, false],
    ["its item type switched on", {}, only("lumexiaLotItemTypeIds", [ITEM]), true],
    [
      "its procurement type switched on",
      {},
      only("lumexiaLotProcurementTypeIds", [PROCUREMENT]),
      true,
    ],
    ["its inventory type switched on", {}, only("lumexiaLotInventoryTypeIds", [INVENTORY]), true],
    ["only other types switched on", {}, only("lumexiaLotItemTypeIds", [OTHER]), false],
    [
      "a type id switched on in another kind's list",
      {},
      only("lumexiaLotInventoryTypeIds", [ITEM]),
      false,
    ],
    ["override true, nothing switched on", { lotOverride: true }, none, true],
    [
      "override false, its type switched on",
      { lotOverride: false },
      only("lumexiaLotItemTypeIds", [ITEM]),
      false,
    ],
    [
      "unlinked, its type switched on",
      { lumexiaItemId: null },
      only("lumexiaLotItemTypeIds", [ITEM]),
      false,
    ],
    ["unlinked, override true", { lumexiaItemId: null, lotOverride: true }, none, false],
    [
      "non-physical, its type switched on",
      { physical: false },
      only("lumexiaLotItemTypeIds", [ITEM]),
      false,
    ],
    ["non-physical, override true", { physical: false, lotOverride: true }, none, false],
    [
      "linked with null type ids",
      {
        lumexiaItemTypeId: null,
        lumexiaProcurementTypeId: null,
        lumexiaInventoryTypeId: null,
      },
      only("lumexiaLotItemTypeIds", [ITEM]),
      false,
    ],
  ])("%s → %s", (_case, product, settings, expected) => {
    expect(needsLot({ ...linked, ...product }, settings)).toBe(expected);
  });
});
