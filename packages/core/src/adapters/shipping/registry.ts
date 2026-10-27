import { providerCredentialSchemas } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { z } from "zod";
import { readProviderCredentials } from "./credentials";
import { createFakeShippingProvider, type FakeLabel } from "./fake";
import { type ProviderId, providerIds, type ShippingProvider } from "./provider";
import { ShipStationAdapter } from "./shipstation/adapter";

// Builds the adapters core calls (SPEC-carriers "Registry"). Services take the list as an
// argument, so tests pass fakes directly; this is where the app gets the real ones.

/** Each provider's credential fields (defined with the API contract), stored as one JSON blob. */
export { providerCredentialSchemas };

export type ProviderCredentials = {
  [Id in ProviderId]: z.output<(typeof providerCredentialSchemas)[Id]>;
};

export type AdapterFactories = {
  [Id in ProviderId]?: (
    credentials: ProviderCredentials[Id],
    config: Record<string, unknown>,
  ) => ShippingProvider;
};

/** The real adapters in this build. A provider missing here can't be enabled. */
export const shippingAdapters: AdapterFactories = {
  SHIPSTATION: (credentials) => new ShipStationAdapter(credentials),
};

/**
 * `SHIPPING_PROVIDERS=fake` swaps every adapter for its fake, for the dev stack and Playwright
 * (there is no ShipStation sandbox there). Fails closed: only an explicit development or test
 * environment honours it, like the integration env fallback, or CI (`CI=true`, which GitHub
 * Actions sets), whose Playwright runs the production build where `NODE_ENV` is always production.
 * A deploy sets neither.
 */
export function fakeShippingProviders(): boolean {
  const env = process.env.NODE_ENV;
  const allowed = env === "development" || env === "test" || process.env.CI === "true";
  return process.env.SHIPPING_PROVIDERS === "fake" && allowed;
}

/** Labels the fakes bought in this process, so one request can find another's. */
const fakeLabels = new Map<ProviderId, Map<string, FakeLabel>>();

function fakeLabelsFor(id: ProviderId): Map<string, FakeLabel> {
  const labels = fakeLabels.get(id) ?? new Map<string, FakeLabel>();
  fakeLabels.set(id, labels);
  return labels;
}

/** Whether `id` can be built here: a real adapter, or its fake under `SHIPPING_PROVIDERS=fake`. */
export function shippingAdapterAvailable(
  id: ProviderId,
  adapters: AdapterFactories = shippingAdapters,
): boolean {
  return fakeShippingProviders() || adapters[id] !== undefined;
}

/**
 * The adapter for `id` with these credentials, or null when they don't fit its schema or it has
 * no adapter here. For callers that hold credentials not saved yet (test connection).
 */
export function buildShippingProvider(
  id: ProviderId,
  credentials: unknown,
  config: unknown,
  adapters: AdapterFactories = shippingAdapters,
): ShippingProvider | null {
  const parsed = providerCredentialSchemas[id].safeParse(credentials);
  if (!parsed.success) return null;
  if (fakeShippingProviders()) {
    return createFakeShippingProvider(id, {
      credentials: parsed.data,
      labels: fakeLabelsFor(id),
    });
  }
  const factory = adapters[id] as
    | ((credentials: unknown, config: Record<string, unknown>) => ShippingProvider)
    | undefined;
  const settings = z.record(z.string(), z.unknown()).catch({}).parse(config);
  return factory ? factory(parsed.data, settings) : null;
}

/**
 * One adapter per enabled provider account with credentials (`readProviderCredentials`, so the
 * dev env fallback counts), ShipStation first. Throws rather than skipping when credentials can't
 * be decrypted, so a wrong key is noticed.
 */
export async function createShippingProviders(
  db: Db,
  adapters: AdapterFactories = shippingAdapters,
): Promise<ShippingProvider[]> {
  const accounts = await db.shippingProviderAccount.findMany({ where: { enabled: true } });
  const providers: ShippingProvider[] = [];
  for (const id of providerIds) {
    const account = accounts.find((a) => a.provider === id);
    if (!account) continue;
    const credentials = readProviderCredentials(id, account.credentialsEnc);
    if (credentials === null) continue;
    const provider = buildShippingProvider(id, credentials, account.config, adapters);
    if (provider) providers.push(provider);
  }
  return providers;
}
