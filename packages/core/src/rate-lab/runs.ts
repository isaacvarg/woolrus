import {
  CancelLabRunInput,
  LabAddressValue,
  type LabRunPage,
  type LabRunPreview,
  type LabRunRow,
  LabRunSelection,
  ListLabRunsInput,
  PreviewLabRunInput,
  ShipFromAddress,
  StartLabRunInput,
} from "@woolrus/contracts";
import { type Db, type DbTx, Prisma } from "@woolrus/db";
import { z } from "zod";
import type { ShippingProvider } from "../adapters/shipping/provider";
import { type AdapterFactories, createShippingProviders } from "../adapters/shipping/registry";
import { recordAudit } from "../audit";
import { enqueue } from "../enqueue";
import { AppError, notFound } from "../errors";
import { storedResult, withIdempotency } from "../idempotency";
import { type JobPayloads, queues, RATE_LAB_RUN_EXPIRE_SECONDS } from "../jobs";
import { type Actor, assertCan } from "../permissions";
import { loadSettings } from "../settings/service";
import { toNumber } from "../units";
import { groupRefs } from "./catalog";
import { type Combination, labQuoter } from "./combination";

// Rate Lab suite runs (SPEC-rate-lab "Runs", job `rateLab.run`): every chosen address × every
// chosen parcel, quoted through each enabled provider and logged in rate history as LAB fetches.
// Runs can be cancelled, and a run whose worker died is failed as stalled so it never blocks the next.

/** Combinations quoted at once: three keeps a run quick without crowding the providers. */
export const LAB_CONCURRENCY = 3;

/** A running run with no heartbeat for this long has lost its worker (SPEC-rate-lab "Stuck runs"). */
export const LAB_STALL_MS = 10 * 60_000;

/**
 * A queued run older than this has lost its job: past the job's expiry pg-boss has failed it (a
 * run is never retried), so nothing will pick the run up. Anything shorter could fail a run whose
 * job is legitimately waiting, e.g. for the worker to come back.
 */
export const LAB_QUEUED_STALL_MS = RATE_LAB_RUN_EXPIRE_SECONDS * 1000 + LAB_STALL_MS;

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

/**
 * The ids a run resolved its selection to when it started, kept beside the selection as chosen
 * (`selection.resolved`): the job quotes these, never items that joined the selection while the
 * run was queued. `LabRunSelection` strips it, so the run list and Run again see the selection as
 * chosen. Runs started before it existed have none and resolve the selection again.
 */
const ResolvedSelection = z.object({
  resolved: z
    .object({ addressIds: z.array(z.string()), parcelIds: z.array(z.string()) })
    .optional(),
});

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

/** The resolved ids still active: an item archived since the start is no longer run. */
async function resolveIds(db: Db, ids: { addressIds: string[]; parcelIds: string[] }) {
  const [addresses, parcels] = await Promise.all([
    db.rateLabAddress.findMany({
      where: { id: { in: ids.addressIds }, archivedAt: null },
      orderBy: [{ title: "asc" }, { id: "asc" }],
    }),
    db.rateLabParcel.findMany({
      where: { id: { in: ids.parcelIds }, archivedAt: null },
      include: parcelInclude,
      orderBy: [{ title: "asc" }, { id: "asc" }],
    }),
  ]);
  return { addresses, parcels };
}

/** The selection's counts, and the addresses and parcels behind them. */
async function preview(db: Db | DbTx, selection: Selection) {
  const resolved = await resolveSelection(db, selection);
  const cap = (await loadSettings(db as DbTx)).rateLabMaxCombinations;
  const combinations = resolved.addresses.length * resolved.parcels.length;
  const counts: LabRunPreview = {
    addresses: resolved.addresses.length,
    parcels: resolved.parcels.length,
    combinations,
    cap,
    overCap: combinations > cap,
  };
  return { counts, ...resolved };
}

/** The counts for the New run dialog: addresses × parcels, and whether that's over the cap. */
export async function previewLabRun(
  db: Db,
  actor: Actor,
  input: PreviewLabRunInput,
): Promise<LabRunPreview> {
  assertCan(actor, "ratelab.use");
  return (await preview(db, PreviewLabRunInput.parse(input).selection)).counts;
}

export const labRunInclude = { startedBy: { select: { id: true, name: true } } } as const;
export type LabRunRecord = Prisma.RateLabRunGetPayload<{ include: typeof labRunInclude }>;

export const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Fails every running run whose heartbeat (or start, before the first one) is older than
 * `LAB_STALL_MS`: its worker is gone, and the run would otherwise hold the one-active-run slot.
 * Likewise a run still queued after `LAB_QUEUED_STALL_MS`, whose job is gone.
 */
export async function recoverStalledLabRuns(db: Db | DbTx, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - LAB_STALL_MS);
  const running = await db.rateLabRun.updateMany({
    where: {
      status: "RUNNING",
      OR: [{ heartbeatAt: { lt: before } }, { heartbeatAt: null, startedAt: { lt: before } }],
    },
    data: { status: "FAILED", error: "errors.rateLab.stalled", finishedAt: now },
  });
  const queued = await db.rateLabRun.updateMany({
    where: { status: "QUEUED", createdAt: { lt: new Date(now.getTime() - LAB_QUEUED_STALL_MS) } },
    data: { status: "FAILED", error: "errors.rateLab.notStarted", finishedAt: now },
  });
  return running.count + queued.count;
}

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
  await recoverStalledLabRuns(db);
  let id: string;
  try {
    ({ id } = await db.$transaction(async (tx) =>
      withIdempotency(tx, idempotencyKey, "rateLab.startRun", actor, async () => {
        const { counts, addresses, parcels } = await preview(tx, selection);
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
            selection: {
              ...selection,
              resolved: {
                addressIds: addresses.map((a) => a.id),
                parcelIds: parcels.map((p) => p.id),
              },
            } as Prisma.InputJsonObject,
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
    if (!isUniqueViolation(error)) throw error;
    // A double submit: the same key's other call took the slot first. Answer with its run.
    const replay = await db.$transaction((tx) =>
      storedResult<{ id: string }>(tx, idempotencyKey, "rateLab.startRun", actor),
    );
    if (!replay) throw new AppError("CONFLICT", "errors.rateLab.runActive");
    ({ id } = replay);
  }
  const rows = await labRunRows(db, [
    await db.rateLabRun.findUniqueOrThrow({ where: { id }, include: labRunInclude }),
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
export async function labRunRows(db: Db, runs: LabRunRecord[]): Promise<LabRunRow[]> {
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
    cancelRequested: run.cancelRequestedAt !== null,
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
  await recoverStalledLabRuns(db);
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
    include: labRunInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = runs.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: await labRunRows(db, page),
    nextCursor: runs.length > limit && last ? encodeCursor(last) : null,
  };
}

/**
 * Cancels a suite run: a queued one at once, so its job quotes nothing; a running one is asked to
 * stop, and its job ends CANCELLED once the combinations it's quoting are logged. Asking again
 * changes nothing. Audited.
 */
export async function cancelLabRun(
  db: Db,
  actor: Actor,
  input: CancelLabRunInput,
): Promise<LabRunRow> {
  assertCan(actor, "ratelab.use");
  const { id } = CancelLabRunInput.parse(input);
  await db.$transaction(async (tx) => {
    // Held so the job's claim (QUEUED → RUNNING) waits: the run is cancelled in the state it's in.
    const [locked] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM rate_lab_runs WHERE id = ${id}::uuid AND kind = 'SUITE' FOR UPDATE`;
    if (!locked) throw notFound();
    const run = await tx.rateLabRun.findUniqueOrThrow({ where: { id } });
    if (run.status !== "QUEUED" && run.status !== "RUNNING") {
      throw new AppError("CONFLICT", "errors.rateLab.runNotActive");
    }
    if (run.cancelRequestedAt) return;
    const now = new Date();
    const status = run.status === "QUEUED" ? "CANCELLED" : run.status;
    await tx.rateLabRun.update({
      where: { id },
      data: {
        status,
        cancelRequestedAt: now,
        ...(status === "CANCELLED" && { finishedAt: now }),
      },
    });
    await recordAudit(tx, actor, {
      entityType: "RateLabRun",
      entityId: id,
      action: "cancel",
      before: { status: run.status },
      after: { status },
    });
  });
  const rows = await labRunRows(db, [
    await db.rateLabRun.findUniqueOrThrow({ where: { id }, include: labRunInclude }),
  ]);
  return rows[0] as LabRunRow;
}

type RunPayload = JobPayloads[typeof queues.rateLabRun];

/**
 * `signal`: the job's, aborted when pg-boss expires it or the worker shuts down. The run then
 * starts no new combination and ends FAILED once the ones it's quoting are logged.
 */
export type LabRunOptions = { timeoutMs?: number; signal?: AbortSignal };

type Address = Awaited<ReturnType<typeof resolveSelection>>["addresses"][number];
type Parcel = Awaited<ReturnType<typeof resolveSelection>>["parcels"][number];

/**
 * One `rateLab.run`: works through the run's combinations `LAB_CONCURRENCY` at a time, logs each as
 * a LAB fetch, locks what it quotes, and ends SUCCEEDED, PARTIAL or FAILED. Never retries, never
 * buys. A run that isn't queued any more (picked up already, cancelled, or failed) is left alone.
 * Between combinations it stops when cancel was asked (ending CANCELLED), the run was failed as
 * stalled, or `signal` was aborted (ending FAILED, which frees the one-active slot).
 */
export async function runLabRun(
  db: Db,
  providers: ShippingProvider[],
  { runId }: RunPayload,
  { timeoutMs, signal }: LabRunOptions = {},
): Promise<{ status: string }> {
  const claimed = await db.rateLabRun.updateMany({
    where: { id: runId, kind: "SUITE", status: "QUEUED" },
    data: { status: "RUNNING", startedAt: new Date(), heartbeatAt: new Date() },
  });
  if (claimed.count === 0) return { status: "skipped" };
  const run = await db.rateLabRun.findUniqueOrThrow({ where: { id: runId } });
  try {
    const shipFrom = ShipFromAddress.parse(run.shipFrom);
    // What the start resolved, minus items archived since: the count is what's actually quoted.
    const { resolved } = ResolvedSelection.parse(run.selection);
    const { addresses, parcels } = resolved
      ? await resolveIds(db, resolved)
      : await resolveSelection(db, LabRunSelection.parse(run.selection));
    const combinations = addresses.flatMap((address) =>
      parcels.map((parcel) => ({ address, parcel })),
    );
    await db.rateLabRun.update({
      where: { id: runId },
      data: { combinations: combinations.length },
    });

    const quoter = labQuoter(db, providers, { runId, shipFrom, timeoutMs });
    const combinationOf = (address: Address, parcel: Parcel): Combination => ({
      // The address quotes use: the corrected one when the check corrected it.
      shipTo: LabAddressValue.parse(address.address),
      residential: address.residential,
      labAddressId: address.id,
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
    });

    let stopping = false;
    const goOn = async () => {
      if (stopping || signal?.aborted) {
        stopping = true;
        return false;
      }
      const current = await db.rateLabRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, cancelRequestedAt: true },
      });
      stopping = current.status !== "RUNNING" || current.cancelRequestedAt !== null;
      return !stopping;
    };
    let next = 0;
    const work = async () => {
      while (next < combinations.length && (await goOn())) {
        const combination = combinations[next++];
        if (!combination) return;
        const quoted = combinationOf(combination.address, combination.parcel);
        await quoter.log(quoted, await quoter.quote(quoted));
      }
    };
    await Promise.all(Array.from({ length: LAB_CONCURRENCY }, work));

    const done = await db.rateLabRun.findUniqueOrThrow({ where: { id: runId } });
    // Failed as stalled meanwhile: that answer stands.
    if (done.status !== "RUNNING") return { status: done.status };
    // Aborted (the job expired, or the worker is stopping) before every combination was quoted.
    const aborted =
      signal?.aborted === true &&
      !done.cancelRequestedAt &&
      done.completedCombinations < combinations.length;
    const status = done.cancelRequestedAt
      ? "CANCELLED"
      : aborted || done.quoteCount === 0
        ? "FAILED"
        : done.failureCount > 0
          ? "PARTIAL"
          : "SUCCEEDED";
    await db.rateLabRun.updateMany({
      where: { id: runId, status: "RUNNING" },
      data: {
        status,
        error: aborted
          ? "errors.rateLab.runFailed"
          : status === "FAILED"
            ? "errors.rateLab.noQuotes"
            : null,
        fake: quoter.fakeProviders.size > 0,
        finishedAt: new Date(),
      },
    });
    return { status };
  } catch (error) {
    await db.rateLabRun.updateMany({
      where: { id: runId, status: "RUNNING" },
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
