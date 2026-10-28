import { ShipFromAddress } from "@woolrus/contracts";
import type { Db, Prisma } from "@woolrus/db";
import type { ErrorCode } from "@woolrus/i18n";
import { z } from "zod";
import { shippingErrorFromCause } from "../adapters/shipping/errors";
import {
  type PurchasedLabel,
  type RateRequest,
  type ShipAddress,
  type ShippingProvider,
  withTimeout,
} from "../adapters/shipping/provider";
import { type AdapterFactories, createShippingProviders } from "../adapters/shipping/registry";
import type { ObjectStorage } from "../adapters/storage/storage";
import { recordAudit } from "../audit";
import { resolveShipTo } from "../carriers/address";
import { parcel } from "../carriers/rates";
import { AppError } from "../errors";
import { type Actor, can } from "../permissions";
import { loadSettings } from "../settings/service";
import { liveLabelStatuses } from "../workflow/gates";
import { lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { transition } from "../workflow/service";
import { isStored } from "./complete";

// The `labels.purchase` job (SPEC-qa "The labels.purchase job"). Complete QA already recorded a
// PURCHASING label per package; this buys each one, copies its PDF into our storage and moves the
// order to Ready as the user who pressed the button. The intent is written before every paid call
// (NFR-REL-02), so a retry looks the label up before it can buy twice.

/** One provider call, however long the provider takes to answer. */
export const PURCHASE_TIMEOUT_MS = 30_000;

export type PurchaseDeps = { providers: ShippingProvider[]; storage: ObjectStorage };
export type PurchaseOptions = {
  now?: Date;
  timeoutMs?: number;
  /** The job's last try: a label still unresolved is settled instead of left for another retry. */
  finalAttempt?: boolean;
};
export type PurchasePayload = { orderId: string; requestedById: string };

const unknownKey = "errors.qa.purchaseUnknown" satisfies ErrorCode;

type Outcome =
  | { kind: "done" }
  /** Settled for now and not worth retrying: refused, or waiting for a person. */
  | { kind: "settled" }
  /** Worth another attempt: the provider or storage failed in a way that may pass. */
  | { kind: "retry"; error: unknown };

const labelInclude = {
  package: {
    include: {
      box: true,
      items: { include: { orderItem: true } },
      rates: {
        where: { selected: true },
        include: { carrier: true, service: true },
      },
    },
  },
} as const satisfies Prisma.ShippingLabelInclude;

type Label = Prisma.ShippingLabelGetPayload<{ include: typeof labelInclude }>;
type LabelPackage = NonNullable<Label["package"]>;

class Purchase {
  constructor(
    private readonly db: Db,
    private readonly deps: PurchaseDeps,
    private readonly actor: Actor,
    private readonly orderId: string,
    private readonly now: Date,
    private readonly timeoutMs: number,
    private readonly finalAttempt = false,
  ) {}

  /** Tells the screens something about the order changed. */
  private async notify(): Promise<void> {
    const order = await this.db.order.findUnique({
      where: { id: this.orderId },
      select: { status: true },
    });
    if (order) await notifyOrderChanged(this.db, { id: this.orderId, status: order.status });
  }

  private async fail(label: Label, messageKey: ErrorCode): Promise<Outcome> {
    await this.db.shippingLabel.update({
      where: { id: label.id },
      data: { status: "PURCHASE_FAILED", error: messageKey },
    });
    await this.notify();
    return { kind: "settled" };
  }

  private async markUnknown(label: Label): Promise<Outcome> {
    await this.db.shippingLabel.update({ where: { id: label.id }, data: { error: unknownKey } });
    await this.notify();
    return { kind: "settled" };
  }

  /** The shipment the provider books from, rebuilt from the package and the order. */
  private async shipment(pkg: LabelPackage): Promise<RateRequest | ErrorCode> {
    const order = await this.db.order.findUniqueOrThrow({ where: { id: this.orderId } });
    const to = resolveShipTo({ shippingAddress: order.shipTo, billingAddress: null });
    const from = ShipFromAddress.safeParse((await loadSettings(this.db)).shipFromAddress);
    const size = parcel(pkg);
    if (to.kind !== "complete" || !size) return "errors.carriers.packageIncomplete";
    if (!from.success) return "errors.carriers.noShipFrom";
    const shipTo: ShipAddress = to.address;
    return {
      orderNumber: order.number,
      shipFrom: from.data,
      shipTo,
      residential: order.shipToResidential ?? !shipTo.company,
      package: size,
      items: pkg.items.map((item) => ({
        sku: item.orderItem.sku,
        name: item.orderItem.name,
        quantity: item.quantity,
      })),
      services: [],
    };
  }

  /** Settles one label; never throws, so one package can't stop the others. */
  async settle(label: Label): Promise<Outcome> {
    try {
      if (label.status === "ACTIVE") return await this.copyPdf(label);
      if (label.error === unknownKey) return { kind: "settled" }; // waits for a person
      const pkg = label.package;
      if (!pkg) return await this.fail(label, "errors.carriers.packageIncomplete");
      const provider = this.deps.providers.find((p) => p.id === label.provider);
      if (!provider) return await this.fail(label, "errors.qa.providerUnavailable");

      if (label.purchaseAttemptedAt) {
        // An earlier attempt may have bought it: look before buying, or never buy again.
        if (!provider.capabilities.labelLookup || !provider.findLabel) {
          return await this.markUnknown(label);
        }
        const found = await withTimeout(provider.findLabel(label.idempotencyKey), this.timeoutMs);
        if (found) return await this.bought(label, found);
      }

      const rate = pkg.rates[0];
      if (!rate || (rate.expiresAt && rate.expiresAt <= this.now)) {
        return await this.fail(label, "errors.qa.rateExpired");
      }
      const shipment = await this.shipment(pkg);
      if (typeof shipment === "string") return await this.fail(label, shipment);

      // The intent, committed before the paid call.
      await this.db.shippingLabel.update({
        where: { id: label.id },
        data: { purchaseAttemptedAt: this.now },
      });
      const purchased = await withTimeout(
        provider.purchaseLabel({
          rate: {
            providerRateId: rate.providerRateId ?? undefined,
            providerShipmentId: rate.providerShipmentId ?? undefined,
            carrierExternalId: rate.carrier.externalId,
            serviceCode: rate.service.code,
            providerData: z
              .record(z.string(), z.unknown())
              .catch({})
              .parse(rate.service.providerData),
          },
          shipment: {
            ...shipment,
            services: [
              {
                carrierExternalId: rate.carrier.externalId,
                code: rate.service.code,
                providerData: z
                  .record(z.string(), z.unknown())
                  .catch({})
                  .parse(rate.service.providerData),
              },
            ],
          },
          packageNumber: pkg.number,
          idempotencyKey: label.idempotencyKey,
          reference: shipment.orderNumber,
          format: "pdf",
          size: "4x6",
        }),
        this.timeoutMs,
      );
      return await this.bought(label, purchased);
    } catch (cause) {
      // A refusal is final for this label; anything else (provider down, a timeout) may pass.
      const error = shippingErrorFromCause("purchaseLabel", cause);
      if (error.permanent) return await this.fail(label, error.messageKey);
      if (this.finalAttempt) return await this.resolveUnfinished(label, error.messageKey);
      return { kind: "retry", error: cause };
    }
  }

  /**
   * The last try ended without an answer. Failed only on the provider's word that no label exists
   * (or when no paid call was ever made); a label that may exist waits for a person.
   */
  private async resolveUnfinished(label: Label, messageKey: ErrorCode): Promise<Outcome> {
    if (!(await this.attempted(label))) return await this.fail(label, messageKey);
    const provider = this.deps.providers.find((p) => p.id === label.provider);
    if (!provider?.capabilities.labelLookup || !provider.findLabel)
      return await this.markUnknown(label);
    try {
      const found = await withTimeout(provider.findLabel(label.idempotencyKey), this.timeoutMs);
      return found ? await this.bought(label, found) : await this.fail(label, messageKey);
    } catch {
      return await this.markUnknown(label);
    }
  }

  /** Whether the intent was committed by the attempt that just failed (the loaded row predates it). */
  private async attempted(label: Label): Promise<boolean> {
    const row = await this.db.shippingLabel.findUnique({
      where: { id: label.id },
      select: { purchaseAttemptedAt: true },
    });
    return row?.purchaseAttemptedAt != null;
  }

  /** Records a bought label, then copies its PDF. */
  private async bought(label: Label, purchased: PurchasedLabel): Promise<Outcome> {
    const url = "url" in purchased.document ? purchased.document.url : null;
    await this.db.$transaction(async (tx) => {
      await tx.shippingLabel.update({
        where: { id: label.id },
        data: {
          status: "ACTIVE",
          providerLabelId: purchased.providerLabelId,
          providerShipmentId: purchased.providerShipmentId ?? label.providerShipmentId,
          trackingNumber: purchased.trackingNumber,
          carrierCode: purchased.carrierCode,
          serviceCode: purchased.serviceCode,
          costCents: purchased.costCents ?? label.quotedAmountCents,
          currency: purchased.currency,
          shipDate: purchased.shipDate,
          purchasedAt: this.now,
          pdfUrl: url,
          error: null,
        },
      });
      await recordAudit(tx, this.actor, {
        entityType: "ShippingLabel",
        entityId: label.id,
        action: "label.purchase",
        after: {
          packageId: label.packageId,
          trackingNumber: purchased.trackingNumber,
          costCents: purchased.costCents ?? label.quotedAmountCents,
          quotedAmountCents: label.quotedAmountCents,
        },
        at: this.now,
      });
    });
    await this.notify();
    return this.copyPdf({ ...label, status: "ACTIVE", pdfUrl: url }, purchased);
  }

  /** Puts the label's PDF in our storage. A failure is retried; nothing is bought again. */
  private async copyPdf(label: Label, purchased?: PurchasedLabel): Promise<Outcome> {
    try {
      const bytes = await this.pdfBytes(label, purchased);
      const key = `labels/${label.id}.pdf`;
      await this.deps.storage.put(key, bytes, "application/pdf");
      await this.db.shippingLabel.update({ where: { id: label.id }, data: { storageKey: key } });
      await this.notify();
      return { kind: "done" };
    } catch (error) {
      return { kind: "retry", error };
    }
  }

  private async pdfBytes(label: Label, purchased?: PurchasedLabel): Promise<Uint8Array> {
    if (purchased && "pdf" in purchased.document) return purchased.document.pdf;
    let url = purchased && "url" in purchased.document ? purchased.document.url : label.pdfUrl;
    if (!url) {
      // The bytes came with the purchase and weren't kept: ask the provider for the label again.
      const provider = this.deps.providers.find((p) => p.id === label.provider);
      const found = await provider?.findLabel?.(label.idempotencyKey);
      if (!found) throw new Error("no PDF source for the label");
      if ("pdf" in found.document) return found.document.pdf;
      url = found.document.url;
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`label PDF download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** QA → Ready as the requester, once every package has its label stored. Never throws for a refusal. */
  async finish(requestedById: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: requestedById } });
    if (!user?.active) return;
    const actor: Actor = { userId: user.id, roles: user.roles, stationId: null };
    if (!can(actor, "order.qa")) return;

    await this.db.$transaction(async (tx) => {
      const order = await lockOrder(tx, this.orderId);
      if (order.status !== "QA" || order.claimedById !== user.id) return;
      const packages = await tx.package.findMany({
        where: { orderId: this.orderId },
        select: {
          labels: {
            where: { status: { in: [...liveLabelStatuses] } },
            select: { status: true, storageKey: true },
          },
        },
      });
      if (
        packages.length === 0 ||
        !packages.every((p) => p.labels.length > 0 && p.labels.every(isStored))
      ) {
        return;
      }
      try {
        await transition(
          tx,
          actor,
          {
            orderId: this.orderId,
            expectedVersion: order.version,
            to: "READY",
            kind: "completeQa",
          },
          { now: this.now, ignoreClaimExpiry: true },
        );
      } catch (error) {
        // Held, a critical issue, a takeover: the labels stay and the next Complete QA moves it.
        if (!(error instanceof AppError)) throw error;
      }
    });
  }
}

/**
 * One `labels.purchase` run for an order. Throws, so pg-boss retries, when a label's outcome may
 * still change (the provider was unavailable, or a PDF copy failed); a refusal is final for that
 * label and doesn't throw.
 */
export async function purchaseLabels(
  db: Db,
  deps: PurchaseDeps,
  { orderId, requestedById }: PurchasePayload,
  { now = new Date(), timeoutMs = PURCHASE_TIMEOUT_MS, finalAttempt = false }: PurchaseOptions = {},
): Promise<void> {
  const requester = await db.user.findUnique({ where: { id: requestedById } });
  const actor: Actor = {
    userId: requestedById,
    roles: requester?.roles ?? [],
    stationId: null,
  };
  const run = new Purchase(db, deps, actor, orderId, now, timeoutMs, finalAttempt);

  const labels = await db.shippingLabel.findMany({
    where: {
      package: { orderId },
      OR: [{ status: "PURCHASING" }, { status: "ACTIVE", storageKey: null }],
    },
    include: labelInclude,
    orderBy: { createdAt: "asc" },
  });
  const outcomes = await Promise.all(labels.map((label) => run.settle(label)));

  const retry = outcomes.find((o) => o.kind === "retry");
  if (retry) throw retry.error;
  await run.finish(requestedById);
}

export type PurchaseJobOptions = {
  adapters?: AdapterFactories;
  storage: ObjectStorage;
  finalAttempt?: boolean;
};

/** The worker's handler: the enabled providers, then `purchaseLabels`. */
export async function runLabelsPurchaseJob(
  db: Db,
  payload: PurchasePayload,
  { adapters, storage, finalAttempt }: PurchaseJobOptions,
): Promise<void> {
  const providers = await createShippingProviders(db, adapters);
  await purchaseLabels(db, { providers, storage }, payload, { finalAttempt });
}
