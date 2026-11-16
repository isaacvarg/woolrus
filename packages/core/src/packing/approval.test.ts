import type { ApprovedTrip, PackApprovalInput } from "@woolrus/contracts";
import type { Db, PackCheckMode, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { hashBadgeCode, hashPin } from "../identity/credentials";
import type { UserActor } from "../permissions";
import { orderMutations } from "../workflow/detail";
import { completePack } from "./complete";
import { setWeight } from "./service";

// SPEC-packing A1 criteria 19 and 20: a blocking trip stops Complete packing until a QA or Admin
// user approves it in person, through packing's completePack and the API's complete-packing alike.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const PIN = "482916";
const WRONG = "111112";

type Modes = Partial<
  Record<
    | "packCheckOverMax"
    | "packCheckUnderMin"
    | "packCheckWeightOff"
    | "packCheckWeightStale"
    | "packCheckNoFit"
    | "packCheckBoxNotScanned"
    | "packCheckCustomDimensions",
    PackCheckMode
  >
>;
const setModes = (modes: Modes) =>
  db.settings.upsert({ where: { id: 1 }, create: { id: 1, ...modes }, update: modes });

/** Someone with a PIN and a badge. */
async function person(roles: Role[]) {
  const actor = await createActor(db, roles);
  const badge = `WRB-${crypto.randomUUID()}`;
  await db.user.update({
    where: { id: actor.userId },
    data: { pinHash: await hashPin(PIN), badgeCode: hashBadgeCode(badge) },
  });
  return { ...actor, badge };
}

/** The approval as the dialog sends it: by default for package 1's NO_FIT, the trip it showed. */
const withPin = (
  approver: UserActor,
  pin = PIN,
  reason = "Pail rides on top",
  trips: ApprovedTrip[] = [{ package: 1, check: "NO_FIT" }],
): PackApprovalInput => ({ credential: { userId: approver.userId, pin }, reason, trips });

/**
 * A Packing order claimed by a packer (with a PIN), whose one package is a 10×8×4 box holding a
 * 7×7×8 pail: NO_FIT trips. The weight matches the estimate, so nothing else does.
 */
async function noFit() {
  const packer = await person(["PACKER"]);
  const built = await createOrder(db, {
    status: "PACKING",
    version: 3,
    claimedById: packer.userId,
    claimedAt: new Date(),
    lines: [
      {
        name: "Pail 5 gal",
        quantity: 1,
        pickStatus: "PICKED",
        size: { lengthIn: 7, widthIn: 7, heightIn: 8, weightOz: 16 },
      },
    ],
    packages: [{ items: [{ line: 0, quantity: 1 }], weightOz: 16 }],
  });
  return { packer, ...built };
}

const finish = (packer: UserActor, orderId: string, approval?: PackApprovalInput) =>
  completePack(db, packer, { orderId, expectedVersion: 3, after: "queue", approval });

const finishByApi = (packer: UserActor, id: string, approval?: PackApprovalInput) =>
  orderMutations.completePacking(db, packer, { id, expectedVersion: 3, approval });

const statusOf = async (orderId: string) =>
  (await db.order.findUniqueOrThrow({ where: { id: orderId } })).status;

const gateKeys = (error: unknown) =>
  ((error as { unmet?: { messageKey: string }[] }).unmet ?? []).map((u) => u.messageKey);

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe.each([
  ["completePack", finish],
  ["the API's complete-packing", finishByApi],
] as const)("with NO_FIT on block, %s", (_name, complete) => {
  beforeEach(() => setModes({ packCheckNoFit: "BLOCK" }));

  it("fails with packCheckBlocked and moves nothing", async () => {
    const { packer, order } = await noFit();

    const error = await refusal(complete(packer, order.id));

    expect(error).toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.workflow.gateFailed",
      unmet: [
        {
          messageKey: "errors.workflow.gate.packCheckBlocked",
          params: { package: 1, check: "NO_FIT" },
        },
      ],
    });
    expect(await statusOf(order.id)).toBe("PACKING");
    expect(await db.packageCheckTrip.count()).toBe(0);
  });

  it("moves the order with a QA user's approval, recording it on the blocking trips", async () => {
    const { packer, order } = await noFit();
    const qa = await person(["QA"]);

    await complete(packer, order.id, withPin(qa));

    expect(await statusOf(order.id)).toBe("QA");
    const approvals = await db.approval.findMany();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      kind: "PACKING_CHECKS",
      entityType: "Order",
      entityId: order.id,
      requestedById: packer.userId,
      approvedById: qa.userId,
      reason: "Pail rides on top",
      details: [
        {
          package: 1,
          check: "NO_FIT",
          details: { boxName: expect.any(String), items: ["Pail 5 gal"] },
        },
      ],
    });
    const trips = await db.packageCheckTrip.findMany();
    expect(trips).toMatchObject([{ check: "NO_FIT", mode: "BLOCK", approvalId: approvals[0]?.id }]);
  });

  it("refuses the packer's own PIN, a Packer's PIN and a wrong PIN, and moves nothing", async () => {
    const { packer, order } = await noFit();
    const otherPacker = await person(["PACKER"]);
    const qa = await person(["QA"]);

    expect(await refusal(complete(packer, order.id, withPin(packer)))).toMatchObject({
      messageKey: "errors.approval.self",
    });
    expect(await refusal(complete(packer, order.id, withPin(otherPacker)))).toMatchObject({
      messageKey: "errors.approval.notPermitted",
    });
    expect(await refusal(complete(packer, order.id, withPin(qa, WRONG)))).toMatchObject({
      messageKey: "errors.station.badPin",
    });

    expect(await statusOf(order.id)).toBe("PACKING");
    expect(await db.approval.count()).toBe(0);
    expect(await db.packageCheckTrip.count()).toBe(0);
  });

  it("refuses an approval that doesn't list a trip blocking now, and moves nothing", async () => {
    const { packer, order } = await noFit();
    const qa = await person(["QA"]);

    // The dialog showed nothing (a stale view); NO_FIT blocks at commit.
    const error = await refusal(complete(packer, order.id, withPin(qa, PIN, "Fine", [])));

    expect(error).toMatchObject({ kind: "CONFLICT", messageKey: "errors.packing.tripsChanged" });
    expect(await statusOf(order.id)).toBe("PACKING");
    expect(await db.approval.count()).toBe(0);
    expect(await db.packageCheckTrip.count()).toBe(0);
  });

  it("a valid approval with a stale version moves nothing and writes no Approval", async () => {
    const { packer, order } = await noFit();
    const qa = await person(["QA"]);
    await db.order.update({ where: { id: order.id }, data: { version: 4 } });

    const error = await refusal(complete(packer, order.id, withPin(qa)));

    expect(error).toMatchObject({ kind: "CONFLICT", messageKey: "errors.workflow.stale" });
    expect(await statusOf(order.id)).toBe("PACKING");
    expect(await db.approval.count()).toBe(0);
    expect(await db.packageCheckTrip.count()).toBe(0);
  });
});

describe("approvals listing what the approver saw", () => {
  it("a trip that stopped blocking meanwhile is fine: only those still blocking are recorded", async () => {
    await setModes({ packCheckNoFit: "BLOCK", packCheckWeightStale: "BLOCK" });
    const { packer, order } = await noFit();
    const qa = await person(["QA"]);

    await finish(
      packer,
      order.id,
      withPin(qa, PIN, "Fine", [
        { package: 1, check: "NO_FIT" },
        { package: 1, check: "WEIGHT_STALE" },
      ]),
    );

    expect(await statusOf(order.id)).toBe("QA");
    expect((await db.approval.findFirstOrThrow()).details).toMatchObject([
      { package: 1, check: "NO_FIT" },
    ]);
  });
});

describe.each([
  [
    "UNDER_MIN",
    { packCheckUnderMin: "BLOCK" },
    async (packageId: string) => {
      const box = await db.box.create({
        data: {
          name: `Roomy ${crypto.randomUUID()}`,
          lengthIn: 10,
          widthIn: 10,
          heightIn: 10,
          minWeightOz: 40,
        },
      });
      await db.package.update({ where: { id: packageId }, data: { boxId: box.id } });
    },
  ],
  [
    "WEIGHT_OFF",
    { packCheckWeightOff: "BLOCK" },
    (packageId: string) => db.package.update({ where: { id: packageId }, data: { weightOz: 40 } }),
  ],
  [
    "WEIGHT_STALE",
    { packCheckWeightStale: "BLOCK" },
    (packageId: string) =>
      db.package.update({ where: { id: packageId }, data: { weightStale: true } }),
  ],
  ["BOX_NOT_SCANNED", { packCheckBoxNotScanned: "BLOCK" }, async () => {}],
  [
    "CUSTOM_DIMENSIONS",
    { packCheckCustomDimensions: "BLOCK" },
    (packageId: string) =>
      db.package.update({
        where: { id: packageId },
        data: { boxId: null, lengthIn: 12, widthIn: 12, heightIn: 12 },
      }),
  ],
] as const)("with %s on block", (check, modes, trip) => {
  it("refuses with packCheckBlocked, then completes with an approval", async () => {
    await setModes(modes);
    const { packer, order, packages } = await noFit();
    await trip(packages[0]?.id as string);

    const error = await refusal(finish(packer, order.id));
    expect(error).toMatchObject({
      unmet: [
        { messageKey: "errors.workflow.gate.packCheckBlocked", params: { package: 1, check } },
      ],
    });

    const qa = await person(["QA"]);
    await finish(packer, order.id, withPin(qa, PIN, "Checked", [{ package: 1, check }]));
    expect(await statusOf(order.id)).toBe("QA");
    expect(
      await db.packageCheckTrip.findMany({
        where: { check },
        select: { mode: true, approvalId: true },
      }),
    ).toEqual([{ mode: "BLOCK", approvalId: expect.any(String) }]);
  });
});

describe("approvals that aren't needed", () => {
  it("an approval sent with nothing blocking moves the order and writes no Approval", async () => {
    await setModes({ packCheckNoFit: "WARN" });
    const { packer, order } = await noFit();
    const admin = await person(["ADMIN"]);

    await finish(packer, order.id, withPin(admin));

    expect(await statusOf(order.id)).toBe("QA");
    expect(await db.approval.count()).toBe(0);
    expect(await db.packageCheckTrip.findMany()).toMatchObject([
      { check: "NO_FIT", mode: "WARN", approvalId: null },
    ]);
  });

  it("with every check on warn nothing needs approval", async () => {
    const { packer, order } = await noFit();

    await finish(packer, order.id);

    expect(await statusOf(order.id)).toBe("QA");
  });

  it("an Admin's badge approves too", async () => {
    await setModes({ packCheckNoFit: "BLOCK" });
    const { packer, order } = await noFit();
    const admin = await person(["ADMIN"]);

    await finish(packer, order.id, {
      credential: { badgeCode: admin.badge },
      reason: "Fine",
      trips: [{ package: 1, check: "NO_FIT" }],
    });

    expect(await statusOf(order.id)).toBe("QA");
    expect(await db.approval.findFirst()).toMatchObject({ approvedById: admin.userId });
  });
});

describe("over max on block (criterion 20)", () => {
  /** The pail's package in a box with a 20 oz max; the pail fits. */
  async function capped() {
    const built = await noFit();
    const box = await db.box.create({
      data: {
        name: `Capped ${crypto.randomUUID()}`,
        lengthIn: 10,
        widthIn: 10,
        heightIn: 10,
        maxWeightOz: 20,
      },
    });
    await db.package.update({ where: { id: built.packages[0]?.id }, data: { boxId: box.id } });
    return built;
  }

  it("setWeight saves above the max without a reason, and the gate blocks it instead", async () => {
    await setModes({ packCheckOverMax: "BLOCK", packCheckWeightOff: "OFF" });
    const { packer, order, packages } = await capped();
    const packageId = packages[0]?.id as string;

    // A reason sent anyway isn't kept: the approval's is the one on record.
    await setWeight(db, packer, { packageId, weightOz: 24, overrideReason: "Dense" });
    expect(await db.package.findUniqueOrThrow({ where: { id: packageId } })).toMatchObject({
      weightOverrideReason: null,
    });
    await setWeight(db, packer, { packageId, weightOz: 25 });
    const pkg = await db.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.weightOz?.toNumber()).toBe(25);
    expect(pkg.weightOverrideReason).toBeNull();
    // packing's version bumps on package writes; re-read it.
    const { version } = await db.order.findUniqueOrThrow({ where: { id: order.id } });

    const error = await refusal(
      completePack(db, packer, { orderId: order.id, expectedVersion: version, after: "queue" }),
    );
    expect(gateKeys(error)).toEqual(["errors.workflow.gate.packCheckBlocked"]);
    expect(error).toMatchObject({ unmet: [{ params: { package: 1, check: "OVER_MAX" } }] });

    const qa = await person(["QA"]);
    await completePack(db, packer, {
      orderId: order.id,
      expectedVersion: version,
      after: "queue",
      approval: withPin(qa, PIN, "Dense kit", [{ package: 1, check: "OVER_MAX" }]),
    });
    expect(await statusOf(order.id)).toBe("QA");
    expect(await db.packageCheckTrip.findMany()).toMatchObject([
      { check: "OVER_MAX", mode: "BLOCK", approvalId: expect.any(String) },
    ]);
  });

  it("on warn, the gate still reports packageOverweight for a weight with no reason", async () => {
    await setModes({ packCheckWeightOff: "OFF" });
    const { packer, order, packages } = await capped();
    await db.package.update({ where: { id: packages[0]?.id }, data: { weightOz: 25 } });

    expect(gateKeys(await refusal(finish(packer, order.id)))).toEqual([
      "errors.workflow.gate.packageOverweight",
    ]);
  });
});
