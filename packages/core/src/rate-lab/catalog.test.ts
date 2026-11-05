import type { LabShipAddress } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { AddressCheck, ShipAddress, ShippingProvider } from "../adapters/shipping/provider";
import {
  archiveLabAddress,
  archiveLabGroup,
  createLabAddress,
  createLabGroup,
  duplicateLabAddress,
  listLabAddresses,
  listLabGroups,
  recheckLabAddress,
  renameLabGroup,
  unarchiveLabAddress,
  updateLabAddress,
} from "./catalog";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const typed: LabShipAddress = {
  name: "Ranch house",
  address1: "12 Prairie Street",
  city: "Jordan",
  state: "MT",
  postalCode: "59337",
  country: "US",
};
const corrected: ShipAddress = { ...typed, address1: "12 Prairie St", postalCode: "59337-0012" };

/** A provider that only validates addresses, answering whatever `answer` holds at the time. */
function validator(answer: { current: AddressCheck }): ShippingProvider {
  return {
    id: "SHIPSTATION",
    capabilities: {
      purchase: true,
      addressValidation: true,
      labelLookup: false,
      void: false,
      manifests: false,
    },
    validateAddress: async () => answer.current,
  } as unknown as ShippingProvider;
}

const correctedAnswer: AddressCheck = {
  status: "corrected",
  address: corrected,
  residential: true,
  messages: ["ZIP+4 added."],
};

let key = 0;
const idempotencyKey = () => `key-${String(++key).padStart(8, "0")}`;

async function setUp() {
  const admin = await createActor(db, ["ADMIN"]);
  const answer = { current: correctedAnswer };
  const deps = { providers: [validator(answer)] };
  const west = await createLabGroup(db, admin, {
    idempotencyKey: idempotencyKey(),
    kind: "ADDRESS",
    name: "West",
  });
  const rural = await createLabGroup(db, admin, {
    idempotencyKey: idempotencyKey(),
    kind: "ADDRESS",
    name: "Rural/remote",
  });
  return { admin, answer, deps, west, rural };
}

const lock = (id: string) =>
  db.rateLabAddress.update({ where: { id }, data: { lockedAt: new Date() } });

describe("createLabAddress", () => {
  it("runs the check and stores the typed original, the correction and residential", async () => {
    const { admin, deps, west, rural } = await setUp();
    const address = await createLabAddress(
      db,
      admin,
      {
        idempotencyKey: idempotencyKey(),
        title: "Rural Montana ranch",
        description: "Rural surcharge",
        address: typed,
        groupIds: [west.id, rural.id],
      },
      deps,
    );
    expect(address).toMatchObject({
      title: "Rural Montana ranch",
      description: "Rural surcharge",
      original: typed,
      address: corrected,
      residential: true,
      checkStatus: "CORRECTED",
      checkMessages: ["ZIP+4 added."],
      locked: false,
      archived: false,
      lastQuotedAt: null,
    });
    expect(address.checkedAt).toBeInstanceOf(Date);
    expect(address.groups.map((g) => g.name)).toEqual(["Rural/remote", "West"]);
    const audit = await db.auditEvent.findMany({ where: { entityId: address.id } });
    expect(audit.map((e) => [e.entityType, e.action])).toEqual([["RateLabAddress", "create"]]);
  });

  it("saves unchecked with no validating provider, residential when there's no company", async () => {
    const { admin } = await setUp();
    const create = (address: LabShipAddress) =>
      createLabAddress(
        db,
        admin,
        { idempotencyKey: idempotencyKey(), title: "Plain", address },
        { providers: [] },
      );
    const home = await create(typed);
    expect(home).toMatchObject({
      checkStatus: "UNCHECKED",
      address: typed,
      residential: true,
      checkedAt: null,
    });
    const office = await create({ ...typed, company: "Acme" });
    expect(office.residential).toBe(false);
  });

  it("refuses a group of the other kind or one that doesn't exist", async () => {
    const { admin, deps } = await setUp();
    const boxes = await createLabGroup(db, admin, {
      idempotencyKey: idempotencyKey(),
      kind: "PARCEL",
      name: "Small",
    });
    for (const groupId of [boxes.id, crypto.randomUUID()]) {
      await expect(
        createLabAddress(
          db,
          admin,
          { idempotencyKey: idempotencyKey(), title: "X", address: typed, groupIds: [groupId] },
          deps,
        ),
      ).rejects.toMatchObject({ messageKey: "errors.rateLab.groupInvalid" });
    }
  });

  it("is allowed for the Rate Lab role and forbidden without it", async () => {
    const { deps } = await setUp();
    const picker = await createActor(db, ["PICKER", "RATE_LAB"]);
    await expect(
      createLabAddress(
        db,
        picker,
        { idempotencyKey: idempotencyKey(), title: "Mine", address: typed },
        deps,
      ),
    ).resolves.toMatchObject({ title: "Mine" });
    for (const role of ["SHIPPER", "QA"] as const) {
      const other = await createActor(db, [role]);
      await expect(
        createLabAddress(
          db,
          other,
          { idempotencyKey: idempotencyKey(), title: "No", address: typed },
          deps,
        ),
      ).rejects.toThrowError("errors.forbidden");
    }
  });
});

describe("a locked address", () => {
  async function lockedAddress() {
    const ctx = await setUp();
    const address = await createLabAddress(
      db,
      ctx.admin,
      {
        idempotencyKey: idempotencyKey(),
        title: "Ranch",
        address: typed,
        groupIds: [ctx.west.id],
      },
      ctx.deps,
    );
    await lock(address.id);
    return { ...ctx, address };
  }

  it("refuses address edits but takes title, description and groups", async () => {
    const { admin, deps, address, rural } = await lockedAddress();
    await expect(
      updateLabAddress(db, admin, { id: address.id, address: { ...typed, city: "Circle" } }, deps),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.rateLab.locked" });

    const updated = await updateLabAddress(
      db,
      admin,
      {
        id: address.id,
        title: "Ranch (MT)",
        description: "Remote",
        groupIds: [rural.id],
        // The form sends the address it shows: unchanged, so not an edit.
        address: typed,
      },
      deps,
    );
    expect(updated).toMatchObject({
      title: "Ranch (MT)",
      description: "Remote",
      locked: true,
      address: corrected,
    });
    expect(updated.groups.map((g) => g.name)).toEqual(["Rural/remote"]);
  });

  it("duplicates to an unlocked copy titled (copy) with the same groups", async () => {
    const { admin, address, west } = await lockedAddress();
    const copy = await duplicateLabAddress(db, admin, {
      idempotencyKey: idempotencyKey(),
      id: address.id,
    });
    expect(copy).toMatchObject({
      title: "Ranch (copy)",
      locked: false,
      original: typed,
      address: corrected,
      residential: true,
      checkStatus: "CORRECTED",
      groups: [{ id: west.id, name: "West", archived: false }],
    });
    expect(copy.id).not.toBe(address.id);
    // An unlocked copy takes address edits.
    const moved = await updateLabAddress(
      db,
      admin,
      { id: copy.id, address: { ...typed, city: "Circle" } },
      { providers: [] },
    );
    expect(moved).toMatchObject({ checkStatus: "UNCHECKED", address: { city: "Circle" } });
  });

  it("keeps a duplicated long title within 80 characters", async () => {
    const { admin, deps } = await setUp();
    const long = await createLabAddress(
      db,
      admin,
      { idempotencyKey: idempotencyKey(), title: "x".repeat(80), address: typed },
      deps,
    );
    const copy = await duplicateLabAddress(db, admin, {
      idempotencyKey: idempotencyKey(),
      id: long.id,
    });
    expect(copy.title).toHaveLength(80);
    expect(copy.title.endsWith(" (copy)")).toBe(true);
  });

  it("re-checks only when the result keeps the address and residential", async () => {
    const { admin, answer, deps, address } = await lockedAddress();
    answer.current = { ...correctedAnswer, messages: ["Still fine."] };
    const same = await recheckLabAddress(db, admin, { id: address.id }, deps);
    expect(same).toMatchObject({ checkMessages: ["Still fine."], address: corrected });

    answer.current = { ...correctedAnswer, residential: false };
    await expect(recheckLabAddress(db, admin, { id: address.id }, deps)).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.rateLab.recheckChanged",
    });
    answer.current = { status: "verified", address: typed, residential: true, messages: [] };
    await expect(recheckLabAddress(db, admin, { id: address.id }, deps)).rejects.toMatchObject({
      messageKey: "errors.rateLab.recheckChanged",
    });
    const stored = await db.rateLabAddress.findUniqueOrThrow({ where: { id: address.id } });
    expect(stored.address).toEqual(corrected);
  });

  it("re-checks an unlocked address whatever the result", async () => {
    const { admin, answer, deps } = await setUp();
    const address = await createLabAddress(
      db,
      admin,
      { idempotencyKey: idempotencyKey(), title: "Open", address: typed },
      deps,
    );
    answer.current = { status: "verified", address: typed, residential: false, messages: [] };
    const rechecked = await recheckLabAddress(db, admin, { id: address.id }, deps);
    expect(rechecked).toMatchObject({
      checkStatus: "VERIFIED",
      address: typed,
      residential: false,
    });
    const audit = await db.auditEvent.findMany({
      where: { entityId: address.id },
      orderBy: { at: "asc" },
    });
    expect(audit.map((e) => e.action)).toEqual(["create", "recheck"]);
  });
});

describe("listing, archiving and groups", () => {
  it("filters by group and title, and hides archived addresses by default", async () => {
    const { admin, deps, west, rural } = await setUp();
    const make = (title: string, groupIds: string[]) =>
      createLabAddress(
        db,
        admin,
        { idempotencyKey: idempotencyKey(), title, address: typed, groupIds },
        deps,
      );
    const a = await make("Alpha ranch", [west.id]);
    const b = await make("Beta flat", [west.id, rural.id]);
    await make("Gamma", []);

    const titles = async (input: Parameters<typeof listLabAddresses>[2]) =>
      (await listLabAddresses(db, admin, input)).map((x) => x.title);
    expect(await titles({})).toEqual(["Alpha ranch", "Beta flat", "Gamma"]);
    expect(await titles({ groupIds: [west.id, rural.id] })).toEqual(["Alpha ranch", "Beta flat"]);
    expect(await titles({ search: "RANCH" })).toEqual(["Alpha ranch"]);

    await archiveLabAddress(db, admin, { id: b.id });
    expect(await titles({})).toEqual(["Alpha ranch", "Gamma"]);
    expect(await titles({ includeArchived: true })).toEqual(["Alpha ranch", "Beta flat", "Gamma"]);
    await unarchiveLabAddress(db, admin, { id: b.id });
    expect(await titles({})).toHaveLength(3);
    const audit = await db.auditEvent.findMany({
      where: { entityId: b.id },
      orderBy: { at: "asc" },
    });
    expect(audit.map((e) => e.action)).toEqual(["create", "archive", "unarchive"]);
    expect(a.id).toBeDefined();
  });

  it("names groups uniquely per kind, ignoring case, and hides archived ones", async () => {
    const { admin, west } = await setUp();
    await expect(
      createLabGroup(db, admin, {
        idempotencyKey: idempotencyKey(),
        kind: "ADDRESS",
        name: "west",
      }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.rateLab.groupNameTaken" });
    // The same name is free for parcels.
    await expect(
      createLabGroup(db, admin, { idempotencyKey: idempotencyKey(), kind: "PARCEL", name: "WEST" }),
    ).resolves.toMatchObject({ kind: "PARCEL", name: "WEST" });
    await expect(
      renameLabGroup(db, admin, { id: west.id, name: "RURAL/REMOTE" }),
    ).rejects.toMatchObject({ messageKey: "errors.rateLab.groupNameTaken" });
    expect(await renameLabGroup(db, admin, { id: west.id, name: "  Pacific " })).toMatchObject({
      name: "Pacific",
    });
    // Parsed in core like its siblings: a blank name or a bad id never reaches the database.
    await expect(renameLabGroup(db, admin, { id: west.id, name: "   " })).rejects.toThrow(
      /too_small/,
    );
    await expect(
      duplicateLabAddress(db, admin, { idempotencyKey: idempotencyKey(), id: "nope" }),
    ).rejects.toThrow(/uuid/i);

    await archiveLabGroup(db, admin, { id: west.id });
    const names = async (includeArchived: boolean) =>
      (await listLabGroups(db, admin, { kind: "ADDRESS", includeArchived })).map((g) => g.name);
    expect(await names(false)).toEqual(["Rural/remote"]);
    expect(await names(true)).toEqual(["Pacific", "Rural/remote"]);
    const audit = await db.auditEvent.findMany({
      where: { entityId: west.id },
      orderBy: { at: "asc" },
    });
    expect(audit.map((e) => e.action)).toEqual(["create", "rename", "archive"]);
  });

  it("won't put an address in an archived group it isn't in yet, but keeps one it's in", async () => {
    const { admin, deps, west, rural } = await setUp();
    const address = await createLabAddress(
      db,
      admin,
      { idempotencyKey: idempotencyKey(), title: "Kept", address: typed, groupIds: [west.id] },
      deps,
    );
    await archiveLabGroup(db, admin, { id: west.id });
    await archiveLabGroup(db, admin, { id: rural.id });
    await expect(
      updateLabAddress(db, admin, { id: address.id, groupIds: [west.id, rural.id] }, deps),
    ).rejects.toMatchObject({ messageKey: "errors.rateLab.groupInvalid" });
    const kept = await updateLabAddress(
      db,
      admin,
      { id: address.id, groupIds: [west.id], title: "Kept 2" },
      deps,
    );
    expect(kept.groups).toEqual([{ id: west.id, name: "West", archived: true }]);
  });

  it("allows reading to ratelab.use and forbids changes and reads without the role", async () => {
    const { admin, deps, west } = await setUp();
    const address = await createLabAddress(
      db,
      admin,
      { idempotencyKey: idempotencyKey(), title: "A", address: typed },
      deps,
    );
    const lab = await createActor(db, ["RATE_LAB"]);
    expect(await listLabAddresses(db, lab, {})).toHaveLength(1);
    expect(await listLabGroups(db, lab, { kind: "ADDRESS" })).toHaveLength(2);
    expect(await renameLabGroup(db, lab, { id: west.id, name: "Westish" })).toMatchObject({
      name: "Westish",
    });
    expect(await archiveLabAddress(db, lab, { id: address.id })).toMatchObject({ archived: true });

    const shipper = await createActor(db, ["SHIPPER"]);
    const forbidden = [
      () => listLabAddresses(db, shipper, {}),
      () => listLabGroups(db, shipper, { kind: "ADDRESS" }),
      () => updateLabAddress(db, shipper, { id: address.id, title: "B" }, deps),
      () => recheckLabAddress(db, shipper, { id: address.id }, deps),
      () => duplicateLabAddress(db, shipper, { idempotencyKey: idempotencyKey(), id: address.id }),
      () => archiveLabAddress(db, shipper, { id: address.id }),
      () => unarchiveLabAddress(db, shipper, { id: address.id }),
      () =>
        createLabGroup(db, shipper, {
          idempotencyKey: idempotencyKey(),
          kind: "ADDRESS",
          name: "N",
        }),
      () => renameLabGroup(db, shipper, { id: west.id, name: "N" }),
      () => archiveLabGroup(db, shipper, { id: west.id }),
    ];
    for (const call of forbidden) await expect(call()).rejects.toThrowError("errors.forbidden");
  });

  it("allows each change to the Rate Lab role", async () => {
    const { deps } = await setUp();
    const lab = await createActor(db, ["RATE_LAB"]);
    const group = await createLabGroup(db, lab, {
      idempotencyKey: idempotencyKey(),
      kind: "ADDRESS",
      name: "Mine",
    });
    const address = await createLabAddress(
      db,
      lab,
      { idempotencyKey: idempotencyKey(), title: "A", address: typed, groupIds: [group.id] },
      deps,
    );
    await expect(
      updateLabAddress(db, lab, { id: address.id, title: "B" }, deps),
    ).resolves.toBeTruthy();
    await expect(recheckLabAddress(db, lab, { id: address.id }, deps)).resolves.toBeTruthy();
    await expect(
      duplicateLabAddress(db, lab, { idempotencyKey: idempotencyKey(), id: address.id }),
    ).resolves.toBeTruthy();
    await expect(unarchiveLabAddress(db, lab, { id: address.id })).resolves.toBeTruthy();
    await expect(archiveLabGroup(db, lab, { id: group.id })).resolves.toMatchObject({
      archived: true,
    });
  });

  it("returns the original address when a create is replayed", async () => {
    const { admin, deps } = await setUp();
    const input = { idempotencyKey: idempotencyKey(), title: "Once", address: typed };
    const first = await createLabAddress(db, admin, input, deps);
    expect(await createLabAddress(db, admin, input, deps)).toEqual(first);
    expect(await db.rateLabAddress.count()).toBe(1);
  });
});
