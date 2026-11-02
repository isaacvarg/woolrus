import type {
  CreateManifestInput,
  CreateManifestResult,
  ManifestCandidates,
  ManifestCandidatesInput,
} from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { ShippingError, shippingErrorFromCause } from "../adapters/shipping/errors";
import type { ProviderManifest, ShippingProvider } from "../adapters/shipping/provider";
import type { ObjectStorage } from "../adapters/storage/storage";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { type Actor, assertCan } from "../permissions";

// End-of-day manifests (SPEC-shipping "Manifests", FR-SHIP-14): per carrier account and ship date,
// through providers with the `manifests` capability. The provider's PDF is copied to storage so
// printing never depends on its URL.

/** Manifest PDFs are a page or a few; anything past this isn't one. */
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;
/** The provider calls run inside the advisory-locked transaction, so it outlives their timeouts. */
const TRANSACTION_TIMEOUT_MS = 90_000;

const dayOf = (shipDate: string) => new Date(`${shipDate}T00:00:00.000Z`);
const manifestKey = (id: string) => `manifests/${id}.pdf`;

function providerFor(providers: ShippingProvider[], id: string) {
  return providers.find((p) => p.id === id && p.capabilities.manifests);
}

/**
 * Per carrier account whose provider can manifest: the day's `ACTIVE` labels of Completed orders
 * that no manifest covers, and the manifests already made. Accounts with neither are left out.
 */
export async function manifestCandidates(
  db: Db,
  actor: Actor,
  providers: ShippingProvider[],
  { shipDate }: ManifestCandidatesInput,
): Promise<ManifestCandidates> {
  assertCan(actor, "order.ship");
  const date = dayOf(shipDate);
  const [pending, manifests] = await Promise.all([
    db.shippingLabel.groupBy({
      by: ["carrierId"],
      where: {
        status: "ACTIVE",
        shipDate: date,
        manifestId: null,
        carrierId: { not: null },
        package: { order: { status: "COMPLETED" } },
      },
      _count: { _all: true },
    }),
    db.manifest.findMany({
      where: { shipDate: date },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { labels: true } } },
    }),
  ]);
  const ids = new Set<string>();
  for (const row of pending) if (row.carrierId) ids.add(row.carrierId);
  for (const manifest of manifests) ids.add(manifest.carrierId);
  const carriers = await db.shippingCarrier.findMany({
    where: { id: { in: [...ids] } },
    orderBy: { createdAt: "asc" },
  });
  return {
    shipDate,
    carriers: carriers
      .filter((carrier) => providerFor(providers, carrier.provider))
      .map((carrier) => ({
        carrierId: carrier.id,
        name: carrier.label ?? carrier.providerNickname ?? carrier.name,
        unmanifested: pending.find((row) => row.carrierId === carrier.id)?._count._all ?? 0,
        manifests: manifests
          .filter((m) => m.carrierId === carrier.id)
          .map((m) => ({ id: m.id, createdAt: m.createdAt, labelCount: m._count.labels })),
      })),
  };
}

/** A provider failure as the error key the screen shows; nothing of the provider's text is kept. */
function refused(operation: string, cause: unknown): AppError {
  const error = cause instanceof ShippingError ? cause : shippingErrorFromCause(operation, cause);
  return new AppError("BAD_REQUEST", error.messageKey);
}

async function documentBytes(
  document: ProviderManifest["document"],
  doFetch: typeof fetch,
): Promise<Uint8Array> {
  if ("pdf" in document) return document.pdf;
  // The URL comes from the provider's response: only ever fetch it over https.
  if (!URL.canParse(document.url) || new URL(document.url).protocol !== "https:") {
    throw new AppError("BAD_REQUEST", "errors.shipping.unavailable");
  }
  let response: Response;
  try {
    response = await doFetch(document.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (cause) {
    throw refused("manifestDownload", cause);
  }
  if (!response.ok) throw new AppError("BAD_REQUEST", "errors.shipping.unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES) {
    throw new AppError("BAD_REQUEST", "errors.shipping.unavailable");
  }
  return bytes;
}

/**
 * A manifest the provider already made for exactly some of these labels and we never stored: a
 * create whose response was lost. Anything else it lists (stored, or covering other labels) is
 * not ours to adopt.
 */
async function findExisting(
  tx: DbTx,
  provider: ShippingProvider,
  carrierExternalId: string,
  shipDate: string,
  candidates: Set<string>,
): Promise<ProviderManifest | null> {
  const listed = await provider.findManifests?.({ carrierExternalId, shipDate });
  for (const manifest of listed ?? []) {
    if (manifest.providerLabelIds.length === 0) continue;
    if (!manifest.providerLabelIds.every((id) => candidates.has(id))) continue;
    const stored = await tx.manifest.findFirst({
      where: { provider: provider.id, providerManifestId: manifest.providerManifestId },
      select: { id: true },
    });
    if (!stored) return manifest;
  }
  return null;
}

/**
 * Manifests every candidate label of a carrier account and day at this moment (at least one).
 * Under an advisory lock per (carrier, date), so two presses can't both create one. A manifest
 * the provider made before is found and adopted instead of created again, so a timeout never
 * leaves two. A refusal writes nothing and comes back as its error key. Idempotent per key.
 */
export async function createManifest(
  db: Db,
  actor: Actor,
  providers: ShippingProvider[],
  storage: ObjectStorage,
  input: CreateManifestInput,
  options: { fetch?: typeof fetch } = {},
): Promise<CreateManifestResult> {
  assertCan(actor, "order.ship");
  const { carrierId, shipDate, idempotencyKey } = input;
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`manifest:${carrierId}:${shipDate}`}))`;
      return withIdempotency(tx, idempotencyKey, "shipping.createManifest", actor, async () => {
        const carrier = await tx.shippingCarrier.findUnique({ where: { id: carrierId } });
        if (!carrier) throw notFound();
        const provider = providerFor(providers, carrier.provider);
        if (!provider?.createManifest || !provider.findManifests) {
          throw new AppError("BAD_REQUEST", "errors.shipping.manifestsUnsupported");
        }
        const labels = await tx.shippingLabel.findMany({
          where: {
            carrierId,
            status: "ACTIVE",
            shipDate: dayOf(shipDate),
            manifestId: null,
            package: { order: { status: "COMPLETED" } },
          },
          select: { id: true, providerLabelId: true },
          orderBy: { createdAt: "asc" },
        });
        if (labels.length === 0) {
          throw new AppError("BAD_REQUEST", "errors.shipping.noLabelsToManifest");
        }
        const providerLabelIds = labels.flatMap((l) =>
          l.providerLabelId ? [l.providerLabelId] : [],
        );
        const lookup = { carrierExternalId: carrier.externalId, shipDate };

        let made: ProviderManifest | null;
        try {
          made = await findExisting(
            tx,
            provider,
            carrier.externalId,
            shipDate,
            new Set(providerLabelIds),
          );
        } catch (cause) {
          throw refused("findManifests", cause);
        }
        if (!made) {
          try {
            made = await provider.createManifest({ ...lookup, providerLabelIds });
          } catch (cause) {
            const error =
              cause instanceof ShippingError
                ? cause
                : shippingErrorFromCause("createManifest", cause);
            // A timeout or lost response may still have made one: look before giving up.
            if (error.permanent) throw refused("createManifest", error);
            try {
              made = await findExisting(
                tx,
                provider,
                carrier.externalId,
                shipDate,
                new Set(providerLabelIds),
              );
            } catch {
              made = null;
            }
            if (!made) throw refused("createManifest", error);
          }
        }

        const pdf = await documentBytes(made.document, options.fetch ?? fetch);
        const covered = new Set(made.providerLabelIds);
        const linked = labels.filter((l) => l.providerLabelId && covered.has(l.providerLabelId));
        const manifest = await tx.manifest.create({
          data: {
            carrierId,
            provider: provider.id,
            providerManifestId: made.providerManifestId,
            shipDate: dayOf(shipDate),
            ...("url" in made.document && { formUrl: made.document.url }),
            createdById: actor.userId,
          },
        });
        await storage.put(manifestKey(manifest.id), pdf, "application/pdf");
        await tx.manifest.update({
          where: { id: manifest.id },
          data: { storageKey: manifestKey(manifest.id) },
        });
        await tx.shippingLabel.updateMany({
          where: { id: { in: linked.map((l) => l.id) } },
          data: { manifestId: manifest.id },
        });
        await recordAudit(tx, actor, {
          entityType: "manifest",
          entityId: manifest.id,
          action: "manifest.create",
          after: {
            carrierId,
            shipDate,
            providerManifestId: made.providerManifestId,
            labelCount: linked.length,
          },
        });
        return { manifestId: manifest.id, labelCount: linked.length };
      });
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_TIMEOUT_MS },
  );
}

/** The storage key of a manifest's PDF, for the route that streams it; `order.ship` on every request. */
export async function getManifestPdf(
  db: Db,
  actor: Actor,
  { id }: { id: string },
): Promise<{ key: string }> {
  assertCan(actor, "order.ship");
  const manifest = await db.manifest.findUnique({ where: { id }, select: { storageKey: true } });
  if (!manifest?.storageKey) throw notFound();
  return { key: manifest.storageKey };
}
