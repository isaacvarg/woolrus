import {
  LabAddressValue,
  type LabRunPage,
  type LabRunPreview,
  type LabRunRow,
  LabRunSelection,
  ListLabRunsInput,
  PreviewLabRunInput,
  type RateError,
  ShipFromAddress,
  StartLabRunInput,
} from "@woolrus/contracts";
import { type Db, type DbTx, Prisma } from "@woolrus/db";
import type { z } from "zod";
import type {
  ProviderId,
  RateRequest,
  ShipAddress,
  ShippingProvider,
} from "../adapters/shipping/provider";
import { type AdapterFactories, createShippingProviders } from "../adapters/shipping/registry";
import { recordAudit } from "../audit";
import {
  type LaneProvider,
  laneProviders,
  type ProviderOutcome,
  quoteParcel,
} from "../carriers/quote";
import { enqueue } from "../enqueue";
import { AppError } from "../errors";
import { withIdempotency } from "../idempotency";
import { type JobPayloads, queues } from "../jobs";
import { type Actor, assertCan } from "../permissions";
import { logRateFetch } from "../rate-history/log";
import { loadSettings } from "../settings/service";
import { buildCustoms } from "../shipping/customs";
import { toNumber } from "../units";
import { groupRefs } from "./catalog";

// Rate Lab suite runs (SPEC-rate-lab "Runs", job `rateLab.run`): every chosen address × every
// chosen parcel, quoted through each enabled provider and logged in rate history as LAB fetches.
// Cancel, stuck-run recovery and the run detail are later tickets.

/** Combinations quoted at once: three keeps a run quick without crowding the providers. */
export const LAB_CONCURRENCY = 3;

type Selection = z.output<typeof LabRunSelection>;

/** Active items in any chosen active group or chosen by id; every active item when both are empty. */
function chosen(groupIds: string[], ids: string[]) {
  if (groupIds.length === 0 && ids.length === 0) return { archivedAt: null };
  return {
    archivedAt: null,
    OR: [
      { id: { in: ids } },
      { groups: { some: { groupId: { in: groupIds }, group: { archivedAt: null } } } },
    ],
  };
}

const parcelInclude = {
  items: { include: { product: true }, orderBy: { product: { name: "asc" } } },
} as const satisfies Prisma.RateLabParcelInclude;

/** The addresses and parcels a selection runs, each once (SC 3). */
async function resolveSelection(db: Db | DbTx, selection: Selection) {
  const [addresses, parcels] = await Promise.all([
    db.rateLabAddress.findMany({
      where: chosen(selection.addressGroupIds, selection.addressIds),
      orderBy: [{ title: "asc" }, { id: "asc" }],
    }),
    db.rateLabParcel.findMany({
      where: chosen(selection.parcelGroupIds, selection.parcelIds),
      include: parcelInclude,
      orderBy: [{ title: "asc" }, { id: "asc" }],
    }),
  ]);
  return { addresses, parcels };
}

async function preview(db: Db | DbTx, selection: Selection): Promise<LabRunPreview> {
  const { addresses, parcels } = await resolveSelection(db, selection);
  const cap = (await loadSettings(db as DbTx)).rateLabMaxCombinations;
  const combinations = addresses.length * parcels.length;
  return {
    addresses: addresses.length,
    parcels: parcels.length,
    combinations,
    cap,
    overCap: combinations > cap,
  };
}

/** The counts for the New run dialog: addresses × parcels, and whether that's over the cap. */
export async function previewLabRun(
  db: Db,
  actor: Actor,
  input: PreviewLabRunInput,
): Promise<LabRunPreview> {
  assertCan(actor, "ratelab.use");
  return preview(db, PreviewLabRunInput.parse(input).selection);
}

const runInclude = { startedBy: { select: { id: true, name: true } } } as const;
type RunRow = Prisma.RateLabRunGetPayload<{ include: typeof runInclude }>;

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Queues a suite run of the selection. Refused, creating nothing, when either side is empty, the
 * combinations are over the cap, no provider is enabled, there's no ship-from, or another suite
 * run is queued or running (the one-active-run index decides that, so two starts can't race).
 */
export async function startLabRun(
  db: Db,
  actor: Actor,
  input: StartLabRunInput,
  { providers }: { providers: ShippingProvider[] },
): Promise<LabRunRow> {
  assertCan(actor, "ratelab.use");
  const { idempotencyKey, selection } = StartLabRunInput.parse(input);
  let id: string;
  try {
    ({ id } = await db.$transaction(async (tx) =>
      withIdempotency(tx, idempotencyKey, "rateLab.startRun", actor, async () => {
        const counts = await preview(tx, selection);
        if (counts.combinations === 0) {
          throw new AppError("BAD_REQUEST", "errors.rateLab.emptySelection");
        }
        if (counts.overCap) {
          throw new AppError("BAD_REQUEST", "errors.rateLab.overCap", undefined, {
            params: { combinations: counts.combinations, cap: counts.cap },
          });
        }
        if (providers.length === 0) {
          throw new AppError("BAD_REQUEST", "errors.rateLab.noProviders");
        }
        const shipFrom = ShipFromAddress.safeParse((await loadSettings(tx)).shipFromAddress);
        if (!shipFrom.success) throw new AppError("BAD_REQUEST", "errors.carriers.noShipFrom");
        const run = await tx.rateLabRun.create({
          data: {
            kind: "SUITE",
            startedById: actor.userId,
            selection: selection as Prisma.InputJsonObject,
            shipFrom: shipFrom.data as Prisma.InputJsonObject,
            combinations: counts.combinations,
          },
        });
        await enqueue(tx, queues.rateLabRun, { runId: run.id });
        await recordAudit(tx, actor, {
          entityType: "RateLabRun",
          entityId: run.id,
          action: "start",
          after: { selection, combinations: counts.combinations } as Prisma.InputJsonObject,
        });
        return { id: run.id };
      }),
    ));
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("CONFLICT", "errors.rateLab.runActive");
    throw error;
  }
  const rows = await toRows(db, [
    await db.rateLabRun.findUniqueOrThrow({ where: { id }, include: runInclude }),
  ]);
  return rows[0] as LabRunRow;
}

/** Where the previous page stopped: createdAt desc, id desc. */
type Cursor = { createdAt: Date; id: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = ({ createdAt, id }: Cursor) =>
  Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString("base64url");

function decodeCursor(cursor: string): Cursor {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    const at = new Date(createdAt);
    if (!Number.isNaN(at.getTime()) && uuid.test(id)) return { createdAt: at, id };
  } catch {
    // Falls through to the refusal below.
  }
  throw new AppError("BAD_REQUEST", "errors.validation", { cursor: "errors.field.invalid" });
}

/** Runs as the list shows them, with the chosen groups' names. */
async function toRows(db: Db, runs: RunRow[]): Promise<LabRunRow[]> {
  const withSelection = runs.map((run) => ({
    run,
    selection: LabRunSelection.catch(LabRunSelection.parse({})).parse(run.selection),
  }));
  const groupIds = [
    ...new Set(
      withSelection.flatMap(({ selection: s }) => [...s.addressGroupIds, ...s.parcelGroupIds]),
    ),
  ];
  const groups =
    groupIds.length === 0
      ? []
      : await db.rateLabGroup.findMany({ where: { id: { in: groupIds } } });
  const side = (ids: string[], items: string[]) => ({
    groups: groupRefs(groups.filter((g) => ids.includes(g.id)).map((group) => ({ group }))),
    items: items.length,
  });
  return withSelection.map(({ run, selection }) => ({
    id: run.id,
    kind: run.kind,
    status: run.status,
    startedBy: run.startedBy,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    combinations: run.combinations,
    completedCombinations: run.completedCombinations,
    quoteCount: run.quoteCount,
    failureCount: run.failureCount,
    fake: run.fake,
    error: run.error,
    addresses: side(selection.addressGroupIds, selection.addressIds),
    parcels: side(selection.parcelGroupIds, selection.parcelIds),
  }));
}

/** Suite runs, newest first. One-off quotes have their own tab. */
export async function listLabRuns(
  db: Db,
  actor: Actor,
  input: ListLabRunsInput,
): Promise<LabRunPage> {
  assertCan(actor, "ratelab.use");
  const { cursor, limit } = ListLabRunsInput.parse(input);
  const after = cursor ? decodeCursor(cursor) : null;
  const runs = await db.rateLabRun.findMany({
    where: {
      kind: "SUITE",
      ...(after && {
        OR: [
          { createdAt: { lt: after.createdAt } },
          { createdAt: after.createdAt, id: { lt: after.id } },
        ],
      }),
    },
    include: runInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = runs.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: await toRows(db, page),
    nextCursor: runs.length > limit && last ? encodeCursor(last) : null,
  };
}

type RunPayload = JobPayloads[typeof queues.rateLabRun];

export type LabRunOptions = { timeoutMs?: number };

type Address = Awaited<ReturnType<typeof resolveSelection>>["addresses"][number];
type Parcel = Awaited<ReturnType<typeof resolveSelection>>["parcels"][number];

/** A combination's answer, before it's logged. */
type Quoted = { request: Omit<RateRequest, "services">; outcomes: ProviderOutcome[] };

/**
 * One `rateLab.run`: works through the run's combinations `LAB_CONCURRENCY` at a time, logs each as
 * a LAB fetch, locks what it quotes, and ends SUCCEEDED, PARTIAL or FAILED. Never retries, never
 * buys. A run that isn't queued any more (picked up already, or cancelled) is left alone.
 */
export async function runLabRun(
  db: Db,
  providers: ShippingProvider[],
  { runId }: RunPayload,
  { timeoutMs }: LabRunOptions = {},
): Promise<{ status: string }> {
  const claimed = await db.rateLabRun.updateMany({
    where: { id: runId, kind: "SUITE", status: "QUEUED" },
    data: { status: "RUNNING", startedAt: new Date(), heartbeatAt: new Date() },
  });
  if (claimed.count === 0) return { status: "skipped" };
  const run = await db.rateLabRun.findUniqueOrThrow({ where: { id: runId } });
  try {
    const shipFrom = ShipFromAddress.parse(run.shipFrom);
    // Items archived since the start are no longer run, so the count is what's actually quoted.
    const { addresses, parcels } = await resolveSelection(db, LabRunSelection.parse(run.selection));
    const combinations = addresses.flatMap((address) =>
      parcels.map((parcel) => ({ address, parcel })),
    );
    await db.rateLabRun.update({
      where: { id: runId },
      data: { combinations: combinations.length },
    });

    const lanes = new Map<boolean, Promise<LaneProvider[]>>();
    const lane = (domestic: boolean) => {
      const found = lanes.get(domestic) ?? laneProviders(db, providers, { domestic });
      lanes.set(domestic, found);
      return found;
    };
    const canPurchase = new Map(providers.map((p) => [p.id, p.capabilities.purchase]));
    const fakeProviders = new Set<ProviderId>(providers.filter((p) => p.fake).map((p) => p.id));
    const orderNumber = `LAB-${runId.slice(-8)}`;

    const quote = async (address: Address, parcel: Parcel): Promise<Quoted> => {
      // The address quotes use: the corrected one when the check corrected it.
      const shipTo: ShipAddress = LabAddressValue.parse(address.address);
      const domestic = shipTo.country === shipFrom.country;
      const request: Omit<RateRequest, "services"> = {
        orderNumber,
        shipFrom,
        shipTo,
        residential: address.residential,
        package: {
          lengthIn: toNumber(parcel.lengthIn) ?? 0,
          widthIn: toNumber(parcel.widthIn) ?? 0,
          heightIn: toNumber(parcel.heightIn) ?? 0,
          weightOz: toNumber(parcel.weightOz) ?? 0,
        },
        items:
          parcel.items.length > 0
            ? parcel.items.map(({ product, quantity }) => ({
                sku: product.sku,
                name: product.name,
                quantity,
              }))
            : [{ sku: null, name: parcel.title, quantity: 1 }],
        // Lab quotes are never bought; quick ones leave no shipment at the provider (open question 1).
        quick: true,
      };
      if (domestic) {
        return { request, outcomes: await quoteParcel(await lane(true), request, { timeoutMs }) };
      }
      // Contents are the only customs source (decision 4): without them nothing can be declared.
      const declaration =
        parcel.items.length === 0
          ? null
          : buildCustoms(
              parcel.items.map(({ product, quantity }) => ({
                sku: product.sku,
                name: product.name,
                quantity,
                unitPriceCents: product.priceCents ?? 0,
                product,
              })),
            );
      if (!declaration?.complete) {
        return {
          request,
          outcomes: [
            {
              provider: null,
              ok: false,
              messageKey: "errors.shipping.customsIncomplete",
              permanent: true,
              params: {
                products: declaration ? declaration.missing.join(", ") : parcel.title,
              },
            },
          ],
        };
      }
      const withCustoms = { ...request, customs: declaration.customs };
      return {
        request: withCustoms,
        outcomes: await quoteParcel(await lane(false), withCustoms, { timeoutMs }),
      };
    };

    const log = async (address: Address, parcel: Parcel, { request, outcomes }: Quoted) => {
      const rates = outcomes.flatMap((o) => (o.ok ? o.rates : []));
      const errors: RateError[] = outcomes.flatMap((o) =>
        o.ok
          ? []
          : [
              {
                provider: o.provider,
                messageKey: o.messageKey,
                ...(o.params && { params: o.params }),
              },
            ],
      );
      await db.$transaction(async (tx) => {
        await logRateFetch(tx, {
          source: "LAB",
          trigger: "LAB_RUN",
          labRunId: runId,
          labAddressId: address.id,
          labParcelId: parcel.id,
          shipTo: request.shipTo,
          residential: request.residential,
          international: request.shipTo.country !== shipFrom.country,
          boxId: parcel.boxId,
          parcel: request.package,
          providerErrors: errors,
          rates: rates.map((rate) => ({
            ...rate,
            carrierId: rate.service.carrierId,
            serviceId: rate.service.id,
            carrierCode: rate.service.carrier.code,
            quoteOnly: canPurchase.get(rate.provider) !== true,
          })),
          fakeProviders,
        });
        // Quoted once, its physical fields are history: lock it with the first fetch (decision 5).
        const now = new Date();
        await tx.rateLabAddress.updateMany({
          where: { id: address.id, lockedAt: null },
          data: { lockedAt: now },
        });
        await tx.rateLabParcel.updateMany({
          where: { id: parcel.id, lockedAt: null },
          data: { lockedAt: now },
        });
        await tx.rateLabRun.update({
          where: { id: runId },
          data: {
            completedCombinations: { increment: 1 },
            quoteCount: { increment: rates.length },
            failureCount: { increment: errors.length },
            heartbeatAt: now,
          },
        });
      });
    };

    let next = 0;
    const work = async () => {
      for (
        let combination = combinations[next++];
        combination;
        combination = combinations[next++]
      ) {
        const { address, parcel } = combination;
        await log(address, parcel, await quote(address, parcel));
      }
    };
    await Promise.all(Array.from({ length: LAB_CONCURRENCY }, work));

    const done = await db.rateLabRun.findUniqueOrThrow({ where: { id: runId } });
    const status =
      done.quoteCount === 0 ? "FAILED" : done.failureCount > 0 ? "PARTIAL" : "SUCCEEDED";
    await db.rateLabRun.update({
      where: { id: runId },
      data: {
        status,
        error: status === "FAILED" ? "errors.rateLab.noQuotes" : null,
        fake: fakeProviders.size > 0,
        finishedAt: new Date(),
      },
    });
    return { status };
  } catch (error) {
    await db.rateLabRun.update({
      where: { id: runId },
      data: { status: "FAILED", error: "errors.rateLab.runFailed", finishedAt: new Date() },
    });
    throw error;
  }
}

/**
 * The worker's handler: the enabled providers, then the run. Providers that can't be built (a
 * credential that no longer decrypts) fail the run rather than leave it queued.
 */
export async function runLabRunJob(
  db: Db,
  payload: RunPayload,
  { adapters, ...options }: LabRunOptions & { adapters?: AdapterFactories } = {},
) {
  let providers: ShippingProvider[];
  try {
    providers = await createShippingProviders(db, adapters);
  } catch (error) {
    await db.rateLabRun.updateMany({
      where: { id: payload.runId, status: "QUEUED" },
      data: { status: "FAILED", error: "errors.rateLab.runFailed", finishedAt: new Date() },
    });
    throw error;
  }
  return runLabRun(db, providers, payload, options);
}
