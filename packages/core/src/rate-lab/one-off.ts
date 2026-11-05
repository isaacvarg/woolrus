import {
  LAB_ONE_OFF_MAX_PARCELS,
  type LabAddress,
  LabAddressValue,
  type LabOneOff,
  type LabOneOffParcel,
  type LabParcel,
  LabShipAddress,
  QuoteOneOffInput,
  SaveOneOffAddressInput,
  SaveOneOffParcelInput,
  ShipFromAddress,
} from "@woolrus/contracts";
import type { Db, Prisma } from "@woolrus/db";
import { z } from "zod";
import { recordAudit } from "../audit";
import { compareRates } from "../carriers/compare";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { loadSettings } from "../settings/service";
import { toNumber } from "../units";
import { type CatalogDeps, checkTestAddress, createLabAddress } from "./catalog";
import { type Combination, type CombinationParcel, labQuoter } from "./combination";
import { createLabParcel, resolveParcelSize } from "./parcels";
import { isUniqueViolation, LAB_CONCURRENCY, recoverStalledLabRuns } from "./runs";

// One-off quotes (SPEC-rate-lab "One-off quotes"): "what would this cost?" for a typed address,
// quoted inline as a ONE_OFF run. The address is checked but not saved as a test address; the
// one-active-run rule is for suite runs only, so a one-off works while one is going. A person has
// one one-off running at a time: each quotes through every provider on the shared credentials.

/** A typed parcel as the run keeps it (`ad_hoc_parcels`): the size it was quoted at. */
const AdHocParcel = z.object({
  boxId: z.string().nullable(),
  lengthIn: z.number(),
  widthIn: z.number(),
  heightIn: z.number(),
  weightOz: z.number(),
});
type AdHocParcel = z.infer<typeof AdHocParcel>;

/**
 * Quotes `address` against the chosen saved parcels (active ones, by id or active group) and the
 * typed ones, 1–20 in all, through every enabled provider. Never buys; quotes are quick ones.
 */
export async function quoteOneOff(
  db: Db,
  actor: Actor,
  input: QuoteOneOffInput,
  deps: CatalogDeps,
): Promise<LabOneOff> {
  assertCan(actor, "ratelab.use");
  const { address, parcelIds, parcelGroupIds, adHocParcels } = QuoteOneOffInput.parse(input);
  const { providers } = deps;

  const saved =
    parcelIds.length === 0 && parcelGroupIds.length === 0
      ? []
      : await db.rateLabParcel.findMany({
          where: {
            archivedAt: null,
            OR: [
              { id: { in: parcelIds } },
              {
                groups: {
                  some: { groupId: { in: parcelGroupIds }, group: { archivedAt: null } },
                },
              },
            ],
          },
          include: { items: { include: { product: true }, orderBy: { product: { name: "asc" } } } },
          orderBy: [{ title: "asc" }, { id: "asc" }],
        });
  // A parcel picked by id must be one that can run; a group may well hold none.
  if (parcelIds.some((id) => !saved.some((parcel) => parcel.id === id))) {
    throw new AppError("BAD_REQUEST", "errors.rateLab.parcelInvalid", {
      parcelIds: "errors.rateLab.parcelInvalid",
    });
  }
  const total = saved.length + adHocParcels.length;
  if (total === 0) throw new AppError("BAD_REQUEST", "errors.rateLab.oneOffNoParcels");
  if (total > LAB_ONE_OFF_MAX_PARCELS) {
    throw new AppError("BAD_REQUEST", "errors.rateLab.oneOffTooMany", undefined, {
      params: { parcels: total, max: LAB_ONE_OFF_MAX_PARCELS },
    });
  }
  if (providers.length === 0) throw new AppError("BAD_REQUEST", "errors.rateLab.noProviders");
  const shipFrom = ShipFromAddress.safeParse((await loadSettings(db)).shipFromAddress);
  if (!shipFrom.success) throw new AppError("BAD_REQUEST", "errors.carriers.noShipFrom");

  const typed: AdHocParcel[] = await Promise.all(
    adHocParcels.map(async ({ size, weightOz }) => ({
      ...(await resolveParcelSize(db, size)),
      weightOz,
    })),
  );

  // The run is created before the address check, so a refused quote asks no provider anything. A
  // one-off whose request died is failed as stalled first, so it doesn't hold the person's slot.
  await recoverStalledLabRuns(db);
  const now = new Date();
  const run = await db
    .$transaction(async (tx) => {
      const created = await tx.rateLabRun.create({
        data: {
          kind: "ONE_OFF",
          status: "RUNNING",
          startedById: actor.userId,
          selection: { addressGroupIds: [], addressIds: [], parcelGroupIds, parcelIds },
          shipFrom: shipFrom.data as Prisma.InputJsonObject,
          adHocAddress: address as Prisma.InputJsonObject,
          adHocParcels: typed as Prisma.InputJsonArray,
          combinations: total,
          startedAt: now,
          heartbeatAt: now,
        },
      });
      // No address in the audit: it may be a customer's, and the PII purge only clears the run.
      await recordAudit(tx, actor, {
        entityType: "RateLabRun",
        entityId: created.id,
        action: "quoteOneOff",
        after: { parcelIds, parcelGroupIds, adHocParcels: typed.length, combinations: total },
      });
      return created;
    })
    .catch((error: unknown) => {
      // The one-running-one-off-per-person index: this person's other one-off is still quoting.
      if (isUniqueViolation(error)) throw new AppError("CONFLICT", "errors.rateLab.oneOffActive");
      throw error;
    });

  try {
    const checked = await checkTestAddress(address, deps);
    const shipTo = LabAddressValue.parse(checked.address);
    const parcels: { combination: Combination; saved: { id: string; title: string } | null }[] = [
      ...saved.map((parcel) => ({
        saved: { id: parcel.id, title: parcel.title },
        combination: {
          shipTo,
          residential: checked.residential,
          labParcelId: parcel.id,
          parcel: {
            title: parcel.title,
            boxId: parcel.boxId,
            lengthIn: toNumber(parcel.lengthIn) ?? 0,
            widthIn: toNumber(parcel.widthIn) ?? 0,
            heightIn: toNumber(parcel.heightIn) ?? 0,
            weightOz: toNumber(parcel.weightOz) ?? 0,
            items: parcel.items,
          },
        },
      })),
      ...typed.map((parcel, index) => ({
        saved: null,
        combination: {
          shipTo,
          residential: checked.residential,
          // A number, as the Quote tab numbers typed parcels: the title reaches message params
          // (customsIncomplete) and the provider's item name, so no English word goes in it.
          parcel: { ...parcel, title: `#${index + 1}`, items: [] } satisfies CombinationParcel,
        },
      })),
    ];

    const quoter = labQuoter(db, providers, { runId: run.id, shipFrom: shipFrom.data });
    const answers: LabOneOffParcel[] = new Array(parcels.length);
    const answer = async (i: number): Promise<LabOneOffParcel> => {
      const { combination, saved: savedParcel } = parcels[i] as (typeof parcels)[number];
      const { rates, errors } = await quoter.log(combination, await quoter.quote(combination));
      const { parcel } = combination;
      return {
        parcel: savedParcel,
        adHocIndex: savedParcel ? null : i - saved.length,
        boxId: parcel.boxId,
        lengthIn: parcel.lengthIn,
        widthIn: parcel.widthIn,
        heightIn: parcel.heightIn,
        weightOz: parcel.weightOz,
        quotes: [...rates].sort(compareRates).map((rate) => ({
          provider: rate.provider,
          carrierName: rate.service.carrier.label ?? rate.service.carrier.name,
          serviceName: rate.serviceName,
          amountCents: rate.amountCents,
          currency: rate.currency,
          deliveryDays: rate.deliveryDays ?? null,
          quoteOnly: rate.quoteOnly,
          cheapest: rate.cheapest,
        })),
        errors,
      };
    };
    // The first combination that throws stops every worker before its next one, and the run fails
    // only once those in flight are done, so nothing calls a provider or bumps the run after that.
    let failure: { error: unknown } | null = null;
    let next = 0;
    const work = async () => {
      for (let i = next++; i < parcels.length && !failure; i = next++) {
        try {
          answers[i] = await answer(i);
        } catch (error) {
          failure ??= { error };
        }
      }
    };
    await Promise.all(Array.from({ length: LAB_CONCURRENCY }, work));
    if (failure) throw (failure as { error: unknown }).error;

    const quotes = answers.reduce((sum, answer) => sum + answer.quotes.length, 0);
    const failures = answers.reduce((sum, answer) => sum + answer.errors.length, 0);
    const status = quotes === 0 ? "FAILED" : failures > 0 ? "PARTIAL" : "SUCCEEDED";
    await db.rateLabRun.update({
      where: { id: run.id },
      data: {
        status,
        error: status === "FAILED" ? "errors.rateLab.noQuotes" : null,
        fake: quoter.fakeProviders.size > 0,
        finishedAt: new Date(),
      },
    });
    return {
      runId: run.id,
      status,
      fake: quoter.fakeProviders.size > 0,
      check: {
        status: checked.checkStatus,
        original: LabAddressValue.parse(address),
        address: shipTo,
        residential: checked.residential,
        messages: checked.checkMessages,
        checkedAt: checked.checkedAt,
      },
      parcels: answers,
    };
  } catch (error) {
    await db.rateLabRun.update({
      where: { id: run.id },
      data: { status: "FAILED", error: "errors.rateLab.runFailed", finishedAt: new Date() },
    });
    throw error;
  }
}

/** A one-off run, or not found: suite runs have nothing typed to save. */
async function oneOffRun(db: Db, runId: string) {
  const run = await db.rateLabRun.findUnique({ where: { id: runId } });
  if (run?.kind !== "ONE_OFF") throw notFound();
  return run;
}

/**
 * **Save as test address**: the one-off's typed address becomes an unlocked test address, checked
 * again on save like any new one. Refused once the PII purge has cleared it.
 */
export async function saveOneOffAddress(
  db: Db,
  actor: Actor,
  input: SaveOneOffAddressInput,
  deps: CatalogDeps,
): Promise<LabAddress> {
  assertCan(actor, "ratelab.manage");
  const { idempotencyKey, runId, title, groupIds } = SaveOneOffAddressInput.parse(input);
  const run = await oneOffRun(db, runId);
  if (run.adHocAddress === null) throw new AppError("CONFLICT", "errors.rateLab.oneOffPurged");
  const address = LabShipAddress.parse(run.adHocAddress);
  return createLabAddress(db, actor, { idempotencyKey, title, address, groupIds }, deps);
}

/**
 * **Save parcel**: typed parcel `index` of a one-off becomes an unlocked test parcel of the size it
 * was quoted at. It keeps its box only while the box is active and still that size.
 */
export async function saveOneOffParcel(
  db: Db,
  actor: Actor,
  input: SaveOneOffParcelInput,
): Promise<LabParcel> {
  assertCan(actor, "ratelab.manage");
  const { idempotencyKey, runId, index, title, groupIds } = SaveOneOffParcelInput.parse(input);
  const run = await oneOffRun(db, runId);
  const typed = z.array(AdHocParcel).catch([]).parse(run.adHocParcels)[index];
  if (!typed) {
    throw new AppError("BAD_REQUEST", "errors.rateLab.oneOffParcelInvalid", {
      index: "errors.rateLab.oneOffParcelInvalid",
    });
  }
  const { boxId, lengthIn, widthIn, heightIn, weightOz } = typed;
  const box = boxId ? await db.box.findUnique({ where: { id: boxId } }) : null;
  const sameBox =
    box !== null &&
    box.archivedAt === null &&
    toNumber(box.lengthIn) === lengthIn &&
    toNumber(box.widthIn) === widthIn &&
    toNumber(box.heightIn) === heightIn;
  return createLabParcel(db, actor, {
    idempotencyKey,
    title,
    size: sameBox ? { boxId } : { lengthIn, widthIn, heightIn },
    weightOz,
    groupIds,
  });
}
