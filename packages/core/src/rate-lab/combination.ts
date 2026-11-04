import type { RateError, ShipFromAddress } from "@woolrus/contracts";
import type { Db, Prisma } from "@woolrus/db";
import type {
  ProviderId,
  RateRequest,
  ShipAddress,
  ShippingProvider,
} from "../adapters/shipping/provider";
import { compareRates } from "../carriers/compare";
import {
  type LaneProvider,
  laneProviders,
  type MatchedRate,
  type ProviderOutcome,
  quoteParcel,
} from "../carriers/quote";
import { logRateFetch } from "../rate-history/log";
import { buildCustoms } from "../shipping/customs";

// One address × one parcel of a Rate Lab run, quoted and logged the same way by suite runs (the
// job) and one-off quotes (inline): a quick quote through each enabled provider, never bought.

type Product = Prisma.ProductGetPayload<object>;

/** A parcel as a combination quotes it. `items` are its contents, the only customs source. */
export type CombinationParcel = {
  title: string;
  boxId: string | null;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightOz: number;
  items: { product: Product; quantity: number }[];
};

export type Combination = {
  shipTo: ShipAddress;
  residential: boolean;
  parcel: CombinationParcel;
  /** The saved test address or parcel, when it is one; typed ones leave them unset. */
  labAddressId?: string;
  labParcelId?: string;
};

/** A combination's answer, before it's logged. */
export type Quoted = { request: Omit<RateRequest, "services">; outcomes: ProviderOutcome[] };

/** What a combination logged: its quotes as kept, and the providers that returned none. */
export type Logged = {
  rates: (MatchedRate & { quoteOnly: boolean; cheapest: boolean })[];
  errors: RateError[];
};

/**
 * Quotes and logs combinations of `runId`. Lanes are looked up once per quoter. Logging a
 * combination locks the saved address and parcel it quoted (decision 5) and counts it on the run.
 */
export function labQuoter(
  db: Db,
  providers: ShippingProvider[],
  { runId, shipFrom, timeoutMs }: { runId: string; shipFrom: ShipFromAddress; timeoutMs?: number },
) {
  const lanes = new Map<boolean, Promise<LaneProvider[]>>();
  const lane = (domestic: boolean) => {
    const found = lanes.get(domestic) ?? laneProviders(db, providers, { domestic });
    lanes.set(domestic, found);
    return found;
  };
  const canPurchase = new Map(providers.map((p) => [p.id, p.capabilities.purchase]));
  const fakeProviders = new Set<ProviderId>(providers.filter((p) => p.fake).map((p) => p.id));
  const orderNumber = `LAB-${runId.slice(-8)}`;

  const quote = async ({ shipTo, residential, parcel }: Combination): Promise<Quoted> => {
    const domestic = shipTo.country === shipFrom.country;
    const request: Omit<RateRequest, "services"> = {
      orderNumber,
      shipFrom,
      shipTo,
      residential,
      package: {
        lengthIn: parcel.lengthIn,
        widthIn: parcel.widthIn,
        heightIn: parcel.heightIn,
        weightOz: parcel.weightOz,
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

  const log = async (combination: Combination, { request, outcomes }: Quoted): Promise<Logged> => {
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
    const logged = rates.map((rate) => ({
      ...rate,
      carrierId: rate.service.carrierId,
      serviceId: rate.service.id,
      carrierCode: rate.service.carrier.code,
      quoteOnly: canPurchase.get(rate.provider) !== true,
    }));
    await db.$transaction(async (tx) => {
      await logRateFetch(tx, {
        source: "LAB",
        trigger: "LAB_RUN",
        labRunId: runId,
        labAddressId: combination.labAddressId,
        labParcelId: combination.labParcelId,
        shipTo: request.shipTo,
        residential: request.residential,
        international: request.shipTo.country !== shipFrom.country,
        boxId: combination.parcel.boxId,
        parcel: request.package,
        providerErrors: errors,
        rates: logged,
        fakeProviders,
      });
      // Quoted once, its physical fields are history: lock it with the first fetch (decision 5).
      const now = new Date();
      if (combination.labAddressId) {
        await tx.rateLabAddress.updateMany({
          where: { id: combination.labAddressId, lockedAt: null },
          data: { lockedAt: now },
        });
      }
      if (combination.labParcelId) {
        await tx.rateLabParcel.updateMany({
          where: { id: combination.labParcelId, lockedAt: null },
          data: { lockedAt: now },
        });
      }
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
    // The same rule the log used to mark its cheapest quote.
    const cheapest = logged.filter((rate) => !rate.quoteOnly).sort(compareRates)[0];
    return { rates: logged.map((rate) => ({ ...rate, cheapest: rate === cheapest })), errors };
  };

  return { quote, log, fakeProviders };
}
