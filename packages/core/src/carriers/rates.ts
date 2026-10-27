import {
  OrderAddress,
  type OrderShipping,
  type OrderShippingInput,
  RateError,
  type RefreshRatesInput,
  ShipFromAddress,
} from "@woolrus/contracts";
import {
  type Db,
  type DbTx,
  Prisma,
  type RatesStatus,
  type ShipToStatus,
  type WorkflowStatus,
} from "@woolrus/db";
import type { ErrorCode } from "@woolrus/i18n";
import { z } from "zod";
import { ShippingError, shippingErrorFromCause } from "../adapters/shipping/errors";
import {
  type AddressCheck,
  PROVIDER_TIMEOUT_MS,
  type ProviderId,
  type ProviderRate,
  providerIds,
  type RateRequest,
  type ShipAddress,
  type ShippingProvider,
} from "../adapters/shipping/provider";
import { type AdapterFactories, createShippingProviders } from "../adapters/shipping/registry";
import { recordAudit } from "../audit";
import { enqueue } from "../enqueue";
import { AppError, notFound } from "../errors";
import { type JobPayloads, queues } from "../jobs";
import { type Actor, assertCan } from "../permissions";
import { loadSettings } from "../settings/service";
import { toNumber } from "../units";
import { liveLabelStatuses } from "../workflow/gates";
import { lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { resolveShipTo } from "./address";
import { listUsableServices } from "./carriers";

// The rate fetch (SPEC-carriers "Rate fetch", job `rates.fetch`): every enabled provider is asked
// for every package in parallel, and the merged rates are stored with the cheapest selected. Each
// enqueue bumps `Order.rateGeneration`, and every write checks it, so a refresh or a package change
// is never overwritten by an older job.

/** How long a rate is good for when the provider gives no expiry (decision 6). */
export const RATE_TTL_HOURS = 24;

/** Every provider failed in a way that may work later: pg-boss retries the job. */
export class RatesRetryError extends Error {
  constructor() {
    super("every shipping provider failed transiently");
    this.name = "RatesRetryError";
  }
}

type RatesPayload = JobPayloads[typeof queues.ratesFetch];

/**
 * Starts a fetch for the order's next generation on the caller's transaction, so it's enqueued
 * only if that commits. The caller holds the order's row lock.
 */
export async function requestRateFetch(tx: DbTx, orderId: string): Promise<number> {
  const { rateGeneration } = await tx.order.update({
    where: { id: orderId },
    data: { rateGeneration: { increment: 1 } },
    select: { rateGeneration: true },
  });
  await enqueue(tx, queues.ratesFetch, { orderId, generation: rateGeneration });
  return rateGeneration;
}

/** Locks the order and says whether `generation` is still its current one. */
async function isCurrent(
  tx: DbTx,
  orderId: string,
  generation: number,
): Promise<WorkflowStatus | null> {
  const [row] = await tx.$queryRaw<{ generation: number; status: WorkflowStatus }[]>`
    SELECT rate_generation AS generation, status::text AS status FROM orders
    WHERE id = ${orderId}::uuid FOR UPDATE`;
  return row?.generation === generation ? row.status : null;
}

export type FetchRatesOptions = {
  now?: Date;
  /** False while pg-boss has retries left: a fetch where every provider failed transiently throws. */
  finalAttempt?: boolean;
  timeoutMs?: number;
};

export type FetchRatesResult = { status: "done" | "stale" };

type UsableService = Awaited<ReturnType<typeof listUsableServices>>[number];

type ProviderOutcome =
  | { provider: ProviderId; ok: true; rates: ProviderRate[] }
  | { provider: ProviderId | null; ok: false; messageKey: ErrorCode; permanent: boolean };

const serviceKey = (carrierExternalId: string, code: string) => `${carrierExternalId}\n${code}`;

/** Cheapest first; ties: fewer delivery days, then provider order, then service name. */
function compareRates(
  a: {
    amountCents: number;
    deliveryDays?: number | null;
    provider: ProviderId;
    serviceName: string;
  },
  b: {
    amountCents: number;
    deliveryDays?: number | null;
    provider: ProviderId;
    serviceName: string;
  },
): number {
  return (
    a.amountCents - b.amountCents ||
    (a.deliveryDays ?? Number.POSITIVE_INFINITY) - (b.deliveryDays ?? Number.POSITIVE_INFINITY) ||
    providerIds.indexOf(a.provider) - providerIds.indexOf(b.provider) ||
    a.serviceName.localeCompare(b.serviceName)
  );
}

/** The provider's whole `getRates` for one package gets `ms`; a late answer is dropped. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DOMException("rate fetch timed out", "TimeoutError")), ms);
  });
  work.catch(() => {}); // a late failure after the timeout isn't anyone's to handle
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function askProvider(
  provider: ShippingProvider,
  request: RateRequest,
  timeoutMs: number,
): Promise<ProviderOutcome> {
  if (request.services.length === 0) {
    return {
      provider: provider.id,
      ok: false,
      messageKey: "errors.carriers.noCarriers",
      permanent: true,
    };
  }
  try {
    return {
      provider: provider.id,
      ok: true,
      rates: await withTimeout(provider.getRates(request), timeoutMs),
    };
  } catch (cause) {
    const error =
      cause instanceof ShippingError ? cause : shippingErrorFromCause("getRates", cause);
    return {
      provider: provider.id,
      ok: false,
      messageKey: error.messageKey,
      permanent: error.permanent,
    };
  }
}

const orderInclude = {
  packages: {
    orderBy: { number: "asc" },
    include: { box: true, items: { include: { orderItem: true } } },
  },
} as const satisfies Prisma.OrderInclude;

type FetchOrder = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;
type FetchPackage = FetchOrder["packages"][number];

/** The package's outer size and weight, or null when it can't be rated yet. */
function parcel(pkg: FetchPackage): RateRequest["package"] | null {
  const dims = (
    own: Prisma.Decimal | null,
    outer?: Prisma.Decimal | null,
    inner?: Prisma.Decimal,
  ) => toNumber(own ?? outer ?? inner ?? null);
  const lengthIn = dims(pkg.lengthIn, pkg.box?.outerLengthIn, pkg.box?.lengthIn);
  const widthIn = dims(pkg.widthIn, pkg.box?.outerWidthIn, pkg.box?.widthIn);
  const heightIn = dims(pkg.heightIn, pkg.box?.outerHeightIn, pkg.box?.heightIn);
  const weightOz = toNumber(pkg.weightOz);
  if (lengthIn === null || widthIn === null || heightIn === null || weightOz === null) return null;
  return { lengthIn, widthIn, heightIn, weightOz };
}

/** Sets every package of the order to `status`, with these errors when it's a failure. */
async function markPackages(
  tx: DbTx,
  orderId: string,
  status: RatesStatus,
  errors: RateError[] | undefined,
  now: Date,
) {
  await tx.package.updateMany({
    where: { orderId },
    data: {
      ratesStatus: status,
      ...(errors ? { rateErrors: errors, ratesFetchedAt: now } : {}),
    },
  });
}

/** What the address check decided: the address rates use, and what's stored about it. */
type CheckedShipTo = {
  shipTo: ShipAddress;
  status: ShipToStatus;
  messages: string[];
  checkedAt: Date | null;
  residential?: boolean;
};

/** What's stored for each answer when rates use the original (a correction does when it has no address). */
const checkStatus: Record<AddressCheck["status"], ShipToStatus> = {
  verified: "VERIFIED",
  corrected: "WARNING",
  warning: "WARNING",
  error: "ERROR",
};

/**
 * FR-SHIP-12: the first provider that can validate checks the resolved address. No such provider,
 * or a check that fails, leaves it `UNCHECKED`; neither ever stops the rate fetch.
 */
async function checkShipTo(
  providers: ShippingProvider[],
  original: ShipAddress,
  now: Date,
  timeoutMs: number,
): Promise<CheckedShipTo> {
  const unchecked: CheckedShipTo = {
    shipTo: original,
    status: "UNCHECKED",
    messages: [],
    checkedAt: null,
  };
  const validator = providers.find((p) => p.capabilities.addressValidation && p.validateAddress);
  if (!validator?.validateAddress) return unchecked;
  let check: AddressCheck;
  try {
    check = await withTimeout(validator.validateAddress(original), timeoutMs);
  } catch {
    return unchecked;
  }
  const checked = { messages: check.messages, checkedAt: now, residential: check.residential };
  // A correction without an address to use is only a warning.
  if (check.status === "corrected" && check.address) {
    return { ...checked, shipTo: check.address, status: "CORRECTED" };
  }
  return { ...checked, shipTo: original, status: checkStatus[check.status] };
}

/**
 * One `rates.fetch` run. Providers are passed in (the job builds the enabled ones), so tests use
 * fakes. Returns `stale` without writing when a newer fetch was requested meanwhile.
 */
export async function fetchRates(
  db: Db,
  providers: ShippingProvider[],
  { orderId, generation }: RatesPayload,
  {
    now = new Date(),
    finalAttempt = true,
    timeoutMs = PROVIDER_TIMEOUT_MS,
  }: FetchRatesOptions = {},
): Promise<FetchRatesResult> {
  const stale = { status: "stale" } as const;
  const done = { status: "done" } as const;
  const order = await db.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order || order.rateGeneration !== generation) return stale;

  // A ship-to already stored (and, from `carriers` validation, maybe corrected) is reused; the
  // address actions and a store address change clear it to resolve again.
  const stored =
    order.shipTo === null
      ? null
      : resolveShipTo({ shippingAddress: order.shipTo, billingAddress: null });
  const resolved = stored?.kind === "complete" ? null : resolveShipTo(order);
  const checked =
    resolved?.kind === "complete"
      ? await checkShipTo(providers, resolved.address, now, timeoutMs)
      : null;
  const shipTo = stored?.kind === "complete" ? stored.address : (checked?.shipTo ?? null);
  const shipFrom = ShipFromAddress.safeParse((await loadSettings(db)).shipFromAddress);

  const started = await db.$transaction(async (tx) => {
    const status = await isCurrent(tx, orderId, generation);
    if (!status) return "stale";
    if (resolved) {
      await tx.order.update({
        where: { id: orderId },
        data:
          resolved.kind === "complete" && checked
            ? {
                shipTo: toJson(checked.shipTo),
                shipToOriginal: toJson(resolved.address),
                shipToStatus: checked.status,
                shipToMessages: checked.messages,
                shipToCheckedAt: checked.checkedAt,
              }
            : {
                shipTo: Prisma.DbNull,
                shipToOriginal: Prisma.DbNull,
                shipToStatus: "INCOMPLETE",
                shipToMessages: resolved.kind === "incomplete" ? resolved.missing : [],
                shipToCheckedAt: null,
              },
      });
    }
    // Nothing a provider could answer: fail every package now, saying why (an incomplete ship-to
    // says so on the order instead).
    const failure: RateError[] | null = !shipTo
      ? []
      : !shipFrom.success
        ? [{ provider: null, messageKey: "errors.carriers.noShipFrom" }]
        : providers.length === 0
          ? [{ provider: null, messageKey: "errors.carriers.noProviders" }]
          : null;
    await markPackages(tx, orderId, failure ? "FAILED" : "FETCHING", failure ?? undefined, now);
    await notifyOrderChanged(tx, { id: orderId, status });
    return failure ? "failed" : "fetching";
  });
  if (started === "stale") return stale;
  if (started === "failed" || !shipTo || !shipFrom.success) return done;

  const domestic = shipTo.country === shipFrom.data.country;
  const usable = await Promise.all(
    providers.map(async (provider) =>
      (await listUsableServices(db, provider.id)).filter((s) =>
        domestic ? s.domestic : s.international,
      ),
    ),
  );
  const base = {
    orderNumber: order.number,
    shipFrom: shipFrom.data,
    shipTo,
    // Assumption 7 unless the address check says.
    residential: checked?.residential ?? !shipTo.company,
  };

  const asked = await Promise.all(
    order.packages.map(async (pkg) => {
      const size = parcel(pkg);
      if (!size) {
        const outcome: ProviderOutcome = {
          provider: null,
          ok: false,
          messageKey: "errors.carriers.packageIncomplete",
          permanent: true,
        };
        return { pkg, outcomes: [outcome] };
      }
      const request = (services: UsableService[]): RateRequest => ({
        ...base,
        package: size,
        items: pkg.items.map((item) => ({
          sku: item.orderItem.sku,
          name: item.orderItem.name,
          quantity: item.quantity,
        })),
        services: services.map((s) => ({
          carrierExternalId: s.carrier.externalId,
          code: s.code,
          providerData: z.record(z.string(), z.unknown()).catch({}).parse(s.providerData),
        })),
      });
      const outcomes = await Promise.all(
        providers.map((provider, i) => askProvider(provider, request(usable[i] ?? []), timeoutMs)),
      );
      return { pkg, outcomes };
    }),
  );

  const outcomes = asked.flatMap((a) => a.outcomes);
  const transient = outcomes.some((o) => !o.ok && !o.permanent);
  if (!finalAttempt && transient && !outcomes.some((o) => o.ok)) throw new RatesRetryError();

  const services = new Map(
    providers.map((provider, i) => [
      provider.id,
      new Map((usable[i] ?? []).map((s) => [serviceKey(s.carrier.externalId, s.code), s])),
    ]),
  );
  const expiry = new Date(now.getTime() + RATE_TTL_HOURS * 3_600_000);
  for (const { pkg, outcomes } of asked) {
    // Extras the provider returned for services that aren't on are dropped.
    const rates = outcomes
      .flatMap((o) =>
        o.ok
          ? o.rates.flatMap((rate) => {
              const service = services
                .get(o.provider)
                ?.get(serviceKey(rate.carrierExternalId, rate.serviceCode));
              return service ? [{ ...rate, provider: o.provider, service }] : [];
            })
          : [],
      )
      .sort(compareRates);
    const errors: RateError[] = outcomes.flatMap((o) =>
      o.ok ? [] : [{ provider: o.provider, messageKey: o.messageKey }],
    );
    const written = await db.$transaction(async (tx) => {
      const status = await isCurrent(tx, orderId, generation);
      if (!status) return false;
      await tx.shippingRate.deleteMany({ where: { packageId: pkg.id } });
      await tx.shippingRate.createMany({
        data: rates.map((rate, i) => ({
          packageId: pkg.id,
          provider: rate.provider,
          carrierId: rate.service.carrierId,
          serviceId: rate.service.id,
          providerRateId: rate.providerRateId ?? null,
          providerShipmentId: rate.providerShipmentId ?? null,
          carrierCode: rate.service.carrier.code,
          serviceCode: rate.serviceCode,
          serviceName: rate.serviceName,
          amountCents: rate.amountCents,
          currency: rate.currency,
          deliveryDays: rate.deliveryDays ?? null,
          estimatedDeliveryAt: rate.estimatedDeliveryAt ?? null,
          guaranteed: rate.guaranteed,
          trackable: rate.trackable,
          selected: i === 0,
          fetchedAt: now,
          expiresAt: rate.expiresAt ?? expiry,
        })),
      });
      await tx.package.update({
        where: { id: pkg.id },
        data: {
          ratesStatus: rates.length > 0 ? "READY" : "FAILED",
          ratesFetchedAt: now,
          rateErrors: errors,
        },
      });
      await notifyOrderChanged(tx, { id: orderId, status });
      return true;
    });
    if (!written) return stale;
  }
  return done;
}

const toJson = (address: ShipAddress) => address as Prisma.InputJsonObject;

export type RatesJobOptions = { finalAttempt?: boolean; adapters?: AdapterFactories };

/** The worker's handler: the enabled providers, then `fetchRates`. */
export async function runRatesFetchJob(
  db: Db,
  payload: RatesPayload,
  { finalAttempt, adapters }: RatesJobOptions = {},
): Promise<FetchRatesResult> {
  const providers = await createShippingProviders(db, adapters);
  return fetchRates(db, providers, payload, { finalAttempt });
}

/** Locks an order QA may re-rate: in QA, with no live label. */
export async function lockRerate(tx: DbTx, orderId: string) {
  const order = await lockOrder(tx, orderId);
  if (order.status !== "QA") throw new AppError("CONFLICT", "errors.carriers.notInQa");
  const live = await tx.shippingLabel.count({
    where: { package: { orderId }, status: { in: [...liveLabelStatuses] } },
  });
  if (live > 0) throw new AppError("CONFLICT", "errors.carriers.liveLabel");
  return order;
}

/**
 * A new generation with every package fetching. `dropRates` when the ship-to changed: rates for
 * the old address can't be bought.
 */
export async function refetch(
  tx: DbTx,
  orderId: string,
  { dropRates = false }: { dropRates?: boolean } = {},
): Promise<number> {
  const generation = await requestRateFetch(tx, orderId);
  if (dropRates) await tx.shippingRate.deleteMany({ where: { package: { orderId } } });
  await tx.package.updateMany({ where: { orderId }, data: { ratesStatus: "FETCHING" } });
  return generation;
}

/** QA asks again: a new generation, every package fetching until the job answers. Audited. */
export async function refreshRates(
  db: Db,
  actor: Actor,
  { orderId }: RefreshRatesInput,
): Promise<OrderShipping> {
  assertCan(actor, "order.qa");
  await db.$transaction(async (tx) => {
    const order = await lockRerate(tx, orderId);
    const generation = await refetch(tx, orderId);
    await recordAudit(tx, actor, {
      entityType: "Order",
      entityId: orderId,
      action: "rates.refresh",
      after: { generation },
    });
    await notifyOrderChanged(tx, { id: orderId, status: order.status });
  });
  return getOrderShipping(db, actor, { orderId });
}

const storedAddress = (value: Prisma.JsonValue | null) => {
  const parsed = OrderAddress.safeParse(value);
  return value !== null && parsed.success ? parsed.data : null;
};
const storedErrors = z.array(RateError).catch([]);
const storedMessages = z.array(z.string()).catch([]);

/** The order's ship-to and, per package, its rates cheapest first (SPEC-carriers "Reads"). */
export async function getOrderShipping(
  db: Db,
  actor: Actor,
  { orderId }: OrderShippingInput,
  { now = new Date() }: { now?: Date } = {},
): Promise<OrderShipping> {
  assertCan(actor, "order.read");
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      shipTo: true,
      shipToOriginal: true,
      shipToStatus: true,
      shipToMessages: true,
      shipToCheckedAt: true,
      packages: {
        orderBy: { number: "asc" },
        select: {
          id: true,
          number: true,
          ratesStatus: true,
          ratesFetchedAt: true,
          rateErrors: true,
          rates: { include: { carrier: { select: { name: true } } } },
          labels: { where: { status: { in: [...liveLabelStatuses] } }, select: { id: true } },
        },
      },
    },
  });
  if (!order) throw notFound();
  return {
    orderId: order.id,
    refreshable: order.status === "QA" && order.packages.every((p) => p.labels.length === 0),
    shipTo: {
      status: order.shipToStatus,
      address: storedAddress(order.shipTo),
      original: storedAddress(order.shipToOriginal),
      messages: storedMessages.parse(order.shipToMessages),
      checkedAt: order.shipToCheckedAt,
    },
    packages: order.packages.map((pkg) => ({
      id: pkg.id,
      number: pkg.number,
      ratesStatus: pkg.ratesStatus,
      ratesFetchedAt: pkg.ratesFetchedAt,
      rateErrors: storedErrors.parse(pkg.rateErrors),
      rates: [...pkg.rates].sort(compareRates).map((rate) => ({
        id: rate.id,
        provider: rate.provider,
        carrierName: rate.carrier.name,
        serviceName: rate.serviceName,
        amountCents: rate.amountCents,
        currency: rate.currency,
        deliveryDays: rate.deliveryDays,
        estimatedDeliveryAt: rate.estimatedDeliveryAt,
        guaranteed: rate.guaranteed,
        expiresAt: rate.expiresAt,
        expired: rate.expiresAt !== null && rate.expiresAt <= now,
        selected: rate.selected,
      })),
    })),
  };
}
