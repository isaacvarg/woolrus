import type { Db, Prisma } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";

// The migration's hand-written constraints (SPEC-rate-lab "Data"), straight against the database.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const run = (data: Partial<Prisma.RateLabRunUncheckedCreateInput> = {}) =>
  db.rateLabRun.create({
    data: { kind: "SUITE", selection: {}, shipFrom: {}, combinations: 1, ...data },
  });

describe("rate lab constraints", () => {
  it("allows one queued or running suite run, and one-offs beside it", async () => {
    await run({ status: "SUCCEEDED" });
    await run({ status: "CANCELLED" });
    const active = await run({ status: "QUEUED" });
    const second = /rate_lab_runs_one_active_suite/;
    await expect(run({ status: "QUEUED" })).rejects.toThrow(second);
    await expect(run({ status: "RUNNING" })).rejects.toThrow(second);
    await expect(run({ kind: "ONE_OFF", status: "RUNNING" })).resolves.toBeTruthy();

    await db.rateLabRun.update({ where: { id: active.id }, data: { status: "RUNNING" } });
    await expect(run()).rejects.toThrow(second);
    await db.rateLabRun.update({ where: { id: active.id }, data: { status: "FAILED" } });
    await expect(run()).resolves.toMatchObject({ status: "QUEUED" });
  });

  it("makes group names unique per kind, ignoring case", async () => {
    await db.rateLabGroup.create({ data: { kind: "ADDRESS", name: "West" } });
    await expect(
      db.rateLabGroup.create({ data: { kind: "ADDRESS", name: "wEST" } }),
    ).rejects.toThrow(/rate_lab_groups_kind_name_key|Unique constraint/);
    await expect(
      db.rateLabGroup.create({ data: { kind: "PARCEL", name: "west" } }),
    ).resolves.toBeTruthy();
  });

  it("keeps the ad hoc address and parcels to one-off runs", async () => {
    const adHoc = /rate_lab_runs_ad_hoc_one_off/;
    await expect(run({ status: "SUCCEEDED", adHocAddress: { city: "Austin" } })).rejects.toThrow(
      adHoc,
    );
    await expect(run({ status: "SUCCEEDED", adHocParcels: [] })).rejects.toThrow(adHoc);
    await expect(
      run({ kind: "ONE_OFF", adHocAddress: { city: "Austin" }, adHocParcels: [] }),
    ).resolves.toBeTruthy();
  });

  it("keeps rate history's own constraint on lab fetches", async () => {
    const suite = await run({ status: "SUCCEEDED" });
    const lane = {
      destCountry: "US",
      residential: true,
      international: false,
      lengthIn: 1,
      widthIn: 1,
      heightIn: 1,
      weightOz: 1,
      fake: true,
    };
    await expect(
      db.rateFetch.create({ data: { ...lane, source: "LAB", trigger: "LAB_RUN" } }),
    ).rejects.toThrow(/rate_fetches_source_ids/);
    await expect(
      db.rateFetch.create({
        data: { ...lane, source: "LAB", trigger: "LAB_RUN", labRunId: suite.id },
      }),
    ).resolves.toBeTruthy();
    // The lab run id is a real foreign key now.
    await expect(
      db.rateFetch.create({
        data: { ...lane, source: "LAB", trigger: "LAB_RUN", labRunId: crypto.randomUUID() },
      }),
    ).rejects.toThrow(/Foreign key|rate_fetches_lab_run_id_fkey/);
  });
});
