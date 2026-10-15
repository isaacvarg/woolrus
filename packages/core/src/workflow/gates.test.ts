import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import {
  evaluateGate,
  type GateLine,
  type GatePackage,
  type GateSnapshot,
  loadGateSnapshot,
} from "./gates";

const line = (overrides: Partial<GateLine> = {}): GateLine => ({
  id: "line-1",
  name: "Tee",
  quantity: 2,
  voidedQuantity: 0,
  physical: true,
  pickStatus: "PICKED",
  pickedQuantity: 2,
  ...overrides,
});

const pkg = (overrides: Partial<GatePackage> = {}): GatePackage => ({
  id: "pkg-1",
  number: 1,
  hasBox: true,
  hasDimensions: false,
  weightOz: 16,
  items: [{ orderItemId: "line-1", quantity: 2, qaVerified: true }],
  selectedRates: 1,
  activeLabels: 1,
  liveLabels: 1,
  ...overrides,
});

const snapshot = (overrides: Partial<GateSnapshot> = {}): GateSnapshot => ({
  status: "READY",
  lines: [line()],
  packages: [pkg()],
  ...overrides,
});

describe("picked gate", () => {
  it("passes when every active line is picked in full", () => {
    expect(evaluateGate("picked", snapshot())).toEqual([]);
  });

  it("accepts substituted lines", () => {
    expect(
      evaluateGate("picked", snapshot({ lines: [line({ pickStatus: "SUBSTITUTED" })] })),
    ).toEqual([]);
  });

  it("reports a line not yet picked", () => {
    const lines = [line({ pickStatus: "PENDING", pickedQuantity: 0 })];
    expect(evaluateGate("picked", snapshot({ lines }))).toEqual([
      { messageKey: "errors.workflow.gate.lineNotPicked", params: { line: "Tee" } },
    ]);
  });

  it("reports a line out of stock", () => {
    const lines = [line({ pickStatus: "OUT_OF_STOCK", pickedQuantity: 0 })];
    expect(evaluateGate("picked", snapshot({ lines }))).toEqual([
      { messageKey: "errors.workflow.gate.lineOutOfStock", params: { line: "Tee" } },
    ]);
  });

  it("reports a picked quantity that doesn't match the active quantity", () => {
    const lines = [line({ pickedQuantity: 1 })];
    expect(evaluateGate("picked", snapshot({ lines }))).toEqual([
      {
        messageKey: "errors.workflow.gate.linePickedQuantity",
        params: { line: "Tee", picked: 1, expected: 2 },
      },
    ]);
  });

  it("subtracts voided quantity", () => {
    const lines = [line({ quantity: 3, voidedQuantity: 1, pickedQuantity: 2 })];
    expect(evaluateGate("picked", snapshot({ lines }))).toEqual([]);
  });

  it("skips fully voided and non-physical lines", () => {
    const lines = [
      line({ id: "a", voidedQuantity: 2, pickStatus: "OUT_OF_STOCK", pickedQuantity: 0 }),
      line({
        id: "b",
        name: "Rush Order",
        physical: false,
        pickStatus: "PENDING",
        pickedQuantity: 0,
      }),
    ];
    expect(evaluateGate("picked", snapshot({ lines }))).toEqual([]);
  });
});

describe("packed gate", () => {
  it("passes when every active line is packed exactly into complete packages", () => {
    expect(evaluateGate("packed", snapshot())).toEqual([]);
  });

  it("adds a line split across packages", () => {
    const packages = [
      pkg({ items: [{ orderItemId: "line-1", quantity: 1, qaVerified: false }] }),
      pkg({
        id: "pkg-2",
        number: 2,
        items: [{ orderItemId: "line-1", quantity: 1, qaVerified: false }],
      }),
    ];
    expect(evaluateGate("packed", snapshot({ packages }))).toEqual([]);
  });

  it("reports an under-packed line", () => {
    const packages = [pkg({ items: [{ orderItemId: "line-1", quantity: 1, qaVerified: false }] })];
    expect(evaluateGate("packed", snapshot({ packages }))).toEqual([
      {
        messageKey: "errors.workflow.gate.lineUnderPacked",
        params: { line: "Tee", packed: 1, expected: 2 },
      },
    ]);
  });

  it("reports an over-packed line, counting voided quantity out", () => {
    const lines = [line({ quantity: 3, voidedQuantity: 1 })];
    const packages = [pkg({ items: [{ orderItemId: "line-1", quantity: 3, qaVerified: false }] })];
    expect(evaluateGate("packed", snapshot({ lines, packages }))).toEqual([
      {
        messageKey: "errors.workflow.gate.lineOverPacked",
        params: { line: "Tee", packed: 3, expected: 2 },
      },
    ]);
  });

  it("reports an empty package", () => {
    const packages = [pkg(), pkg({ id: "pkg-2", number: 2, items: [] })];
    expect(evaluateGate("packed", snapshot({ packages }))).toEqual([
      { messageKey: "errors.workflow.gate.packageEmpty", params: { package: 2 } },
    ]);
  });

  it("reports a package without a box or full override dimensions", () => {
    const packages = [pkg({ hasBox: false, hasDimensions: false })];
    expect(evaluateGate("packed", snapshot({ packages }))).toEqual([
      { messageKey: "errors.workflow.gate.packageNoBox", params: { package: 1 } },
    ]);
    expect(
      evaluateGate("packed", snapshot({ packages: [pkg({ hasBox: false, hasDimensions: true })] })),
    ).toEqual([]);
  });

  it("reports a package without a weight", () => {
    const packages = [pkg({ weightOz: null })];
    expect(evaluateGate("packed", snapshot({ packages }))).toEqual([
      { messageKey: "errors.workflow.gate.packageNoWeight", params: { package: 1 } },
    ]);
  });

  it("doesn't require non-physical or fully voided lines to be packed", () => {
    const lines = [
      line(),
      line({ id: "rush", name: "Rush Order", physical: false }),
      line({ id: "v", voidedQuantity: 2 }),
    ];
    expect(evaluateGate("packed", snapshot({ lines }))).toEqual([]);
  });
});

describe("verified gate", () => {
  it("passes when every item is verified and every package has one rate and one active label", () => {
    expect(evaluateGate("verified", snapshot())).toEqual([]);
  });

  it("reports a package with unverified items", () => {
    const packages = [
      pkg({
        items: [
          { orderItemId: "line-1", quantity: 1, qaVerified: true },
          { orderItemId: "line-1", quantity: 1, qaVerified: false },
        ],
      }),
    ];
    expect(evaluateGate("verified", snapshot({ packages }))).toEqual([
      { messageKey: "errors.workflow.gate.packageNotVerified", params: { package: 1, count: 1 } },
    ]);
  });

  it("reports a package without exactly one selected rate", () => {
    for (const selectedRates of [0, 2]) {
      expect(evaluateGate("verified", snapshot({ packages: [pkg({ selectedRates })] }))).toEqual([
        { messageKey: "errors.workflow.gate.packageNoRate", params: { package: 1 } },
      ]);
    }
  });

  it("reports a package without exactly one active label", () => {
    for (const activeLabels of [0, 2]) {
      expect(evaluateGate("verified", snapshot({ packages: [pkg({ activeLabels })] }))).toEqual([
        { messageKey: "errors.workflow.gate.packageNoLabel", params: { package: 1 } },
      ]);
    }
  });
});

describe("shippable gate", () => {
  it("passes for a Ready order whose packages all have an active label", () => {
    expect(evaluateGate("shippable", snapshot())).toEqual([]);
  });

  it("reports an order that isn't Ready", () => {
    expect(evaluateGate("shippable", snapshot({ status: "QA" }))).toEqual([
      { messageKey: "errors.workflow.gate.notReady", params: {} },
    ]);
  });

  it("reports a package without an active label", () => {
    const packages = [pkg(), pkg({ id: "pkg-2", number: 2, activeLabels: 0 })];
    expect(evaluateGate("shippable", snapshot({ packages }))).toEqual([
      { messageKey: "errors.workflow.gate.packageNoLabel", params: { package: 2 } },
    ]);
  });

  it("reports an order with no packages", () => {
    expect(evaluateGate("shippable", snapshot({ packages: [] }))).toEqual([
      { messageKey: "errors.workflow.gate.noPackages", params: {} },
    ]);
  });
});

describe("noLiveLabels gate", () => {
  it("passes when no package has a live label", () => {
    expect(
      evaluateGate(
        "noLiveLabels",
        snapshot({ packages: [pkg({ activeLabels: 0, liveLabels: 0 })] }),
      ),
    ).toEqual([]);
  });

  it("reports each package with a live label", () => {
    const packages = [pkg(), pkg({ id: "pkg-2", number: 2, liveLabels: 0 })];
    expect(evaluateGate("noLiveLabels", snapshot({ packages }))).toEqual([
      { messageKey: "errors.workflow.gate.packageLiveLabel", params: { package: 1 } },
    ]);
  });
});

describe("loadGateSnapshot", () => {
  const db: Db = testDb();
  afterAll(() => db.$disconnect());
  beforeEach(() => resetDb(db));

  it("reads lines, voids, packages, rates and labels", async () => {
    const { order, items, packages } = await createOrder(db, {
      status: "READY",
      lines: [
        {
          name: "Tee",
          quantity: 3,
          pickStatus: "PICKED",
          voids: [{ quantity: 1 }, { quantity: 1, undone: true }],
        },
        { name: "Rush Order", physical: false },
        { name: "Gone", noProduct: true },
      ],
      packages: [
        {
          items: [{ line: 0, quantity: 2, verified: true }],
          rates: [{ selected: true }, { selected: false }],
          label: "VOID_REQUESTED",
        },
        { boxed: false, weightOz: null, dimensions: { lengthIn: 5, widthIn: 5, heightIn: 5 } },
      ],
    });

    const snap = await db.$transaction((tx) => loadGateSnapshot(tx, order.id));

    expect(snap.status).toBe("READY");
    expect(snap.lines).toEqual([
      expect.objectContaining({
        id: items[0]?.id,
        name: "Tee",
        quantity: 3,
        voidedQuantity: 1,
        physical: true,
      }),
      expect.objectContaining({ id: items[1]?.id, name: "Rush Order", physical: false }),
      expect.objectContaining({ id: items[2]?.id, name: "Gone", physical: true }),
    ]);
    expect(snap.packages).toEqual([
      {
        id: packages[0]?.id,
        number: 1,
        hasBox: true,
        hasDimensions: false,
        weightOz: 16,
        items: [{ orderItemId: items[0]?.id, quantity: 2, qaVerified: true }],
        selectedRates: 1,
        activeLabels: 0,
        liveLabels: 1,
      },
      expect.objectContaining({
        number: 2,
        hasBox: false,
        hasDimensions: true,
        weightOz: null,
        items: [],
      }),
    ]);
  });

  it("throws not found for a missing order", async () => {
    await expect(
      db.$transaction((tx) => loadGateSnapshot(tx, "00000000-0000-7000-8000-000000000000")),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("passes an unpicked Rush Order line once the physical lines are done (SC 9)", async () => {
    const { order } = await createOrder(db, {
      status: "READY",
      lines: [
        { quantity: 2, pickStatus: "PICKED" },
        { name: "Rush Order", physical: false },
      ],
      packages: [
        {
          items: [{ line: 0, quantity: 2, verified: true }],
          rates: [{ selected: true }],
          label: "ACTIVE",
        },
      ],
    });

    const snap = await db.$transaction((tx) => loadGateSnapshot(tx, order.id));

    for (const gate of ["picked", "packed", "verified", "shippable"] as const) {
      expect(evaluateGate(gate, snap)).toEqual([]);
    }
  });
});
