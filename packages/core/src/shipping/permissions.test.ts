import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createMemoryStorage } from "../adapters/storage/memory";
import type { Actor } from "../permissions";
import { customsProducts, orderCustoms, updateProductCustoms } from "./customs";
import { retryVoid, stuckLabels, writeOffLabel } from "./labels";
import { getManifestPdf, manifestCandidates } from "./manifests";
import { createLabelPrint, labelPrintPdf, orderPrintableLabels } from "./print";
import { repackOrders } from "./repack";
import { shipOrders } from "./ship";
import { pushErrors, retryWooPush } from "./woo-push-errors";

// SPEC-shipping criterion 13: every shipping procedure and both PDF routes' core functions are
// allowed for the roles that hold the permission and forbidden for the rest. "Allowed" means the
// call gets past the permission check: whatever it then does to a made-up id is not forbidden.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

type Role = "ADMIN" | "PICKER" | "PACKER" | "QA" | "SHIPPER";
const ALL: Role[] = ["ADMIN", "PICKER", "PACKER", "QA", "SHIPPER"];
const SHIP: Role[] = ["ADMIN", "SHIPPER"];
const PRINT: Role[] = ["ADMIN", "QA", "SHIPPER"];
const REPACK: Role[] = ["ADMIN", "QA", "SHIPPER"];
const ADMIN: Role[] = ["ADMIN"];

const id = "0199e6a0-0000-7000-8000-00000000dead";
const key = () => crypto.randomUUID();
const providers: never[] = [];

const calls: [string, Role[], (a: Actor) => Promise<unknown>][] = [
  [
    "shipOrders",
    SHIP,
    (a) => shipOrders(db, a, { orderIds: [id], confirmUnprinted: false, idempotencyKey: key() }),
  ],
  [
    "createLabelPrint",
    PRINT,
    (a) => createLabelPrint(db, a, { orderIds: [id], idempotencyKey: key() }),
  ],
  ["labelPrintPdf", PRINT, (a) => labelPrintPdf(db, a, createMemoryStorage(), id)],
  ["orderPrintableLabels", PRINT, (a) => orderPrintableLabels(db, a, { orderId: id })],
  [
    "repack",
    REPACK,
    (a) =>
      repackOrders(db, a, { orderIds: [id], reason: "x", idempotencyKey: key() }, { providers }),
  ],
  ["retryVoid", REPACK, (a) => retryVoid(db, a, { labelId: id }, { providers })],
  ["stuckLabels", REPACK, (a) => stuckLabels(db, a, { orderId: id })],
  ["writeOffLabel", ADMIN, (a) => writeOffLabel(db, a, { labelId: id, reason: "lost" })],
  ["pushErrors", ADMIN, (a) => pushErrors(db, a)],
  ["retryWooPush", ADMIN, (a) => retryWooPush(db, a, { orderIds: [id] })],
  ["customsProducts", ADMIN, (a) => customsProducts(db, a, { filter: "all" })],
  [
    "updateProductCustoms",
    ADMIN,
    (a) => updateProductCustoms(db, a, { productId: id, hsCode: "6117.10" }),
  ],
  [
    "manifestCandidates",
    SHIP,
    (a) => manifestCandidates(db, a, providers, { shipDate: "2020-01-02" }),
  ],
  ["getManifestPdf", SHIP, (a) => getManifestPdf(db, a, { id })],
  ["orderCustoms", ALL, (a) => orderCustoms(db, a, { orderId: id })],
];

describe.each(calls)("%s", (_name, allowed, run) => {
  it.each(ALL)("%s", async (role) => {
    const actor = await createActor(db, [role]);
    const outcome = run(actor);
    if (allowed.includes(role)) {
      await outcome.catch((error) => expect(error).not.toMatchObject({ kind: "FORBIDDEN" }));
    } else {
      await expect(outcome).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
  });
});
