// Our carrier codes → the name and tracking link a customer sees (SPEC-shipping "Carrier → tracking
// provider"). The names of the known carriers are AST's own provider names. Pure. Never the label provider's name ("ShipStation", SRS §7.1 #12).

type Known = { name: string; link: (trackingNumber: string) => string };

const known: Record<string, Known> = {
  usps: {
    name: "USPS",
    link: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
  },
  ups: { name: "UPS", link: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}` },
  fedex: {
    name: "FedEx",
    link: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  },
  dhl_express: {
    name: "DHL Express",
    link: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(n)}`,
  },
};

/** The carrier's customer-facing name and, when the table has one, its tracking link. */
export function trackingProvider(
  carrierCode: string,
  displayName: string | null,
  trackingNumber: string,
): { name: string; link: string | null; custom: boolean } {
  const entry = known[carrierCode.toLowerCase()];
  if (entry) return { name: entry.name, link: entry.link(trackingNumber), custom: false };
  return { name: displayName?.trim() || carrierCode, link: null, custom: true };
}
