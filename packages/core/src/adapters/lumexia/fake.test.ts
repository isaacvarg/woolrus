import { describe, expect, it } from "vitest";
import { describeLumexiaClient } from "./contract";
import { FakeLumexiaClient } from "./fake";

describeLumexiaClient("FakeLumexiaClient", (world) => {
  const client = new FakeLumexiaClient(world);
  return { client, failNext: (failure) => client.failNext(failure), secrets: [] };
});

describe("FakeLumexiaClient helpers", () => {
  it("adds items and lots with defaults that the client then returns", async () => {
    const fake = new FakeLumexiaClient();
    const item = fake.addItem({ referenceCode: "BASE1234", itemTypeId: fake.addType("item").id });
    const lot = fake.addLot({ itemId: item.id, lotNumber: "BASE1234.A12A0124" });

    expect(await fake.getItem(item.id)).toEqual(item);
    expect(item).toMatchObject({ aliases: [], archived: false, procurementTypeId: null });
    expect(await fake.getLot(lot.id)).toEqual(lot);
    expect(await fake.findLotsByNumber("BASE1234.A12A0124")).toEqual([lot]);
    expect(await fake.listTypes("item")).toHaveLength(1);
  });

  it("records calls", async () => {
    const fake = new FakeLumexiaClient();
    await fake.findItems({ referenceCodes: ["A"] });
    expect(fake.calls).toEqual([{ method: "findItems", args: [{ referenceCodes: ["A"] }] }]);
  });

  it("can stay down until brought back", async () => {
    const fake = new FakeLumexiaClient();
    fake.setDown(true);
    await expect(fake.ping()).rejects.toThrow("unavailable");
    await expect(fake.getItem("x")).rejects.toThrow("unavailable");
    fake.setDown(false);
    await expect(fake.ping()).resolves.toBeUndefined();
  });
});
