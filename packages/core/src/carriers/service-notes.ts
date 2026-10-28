import type { ServiceNote } from "@woolrus/contracts";
import type { ProviderId } from "../adapters/shipping/provider";

// Where a service really runs, when the provider's domestic/international flags would mislead.
// ShipStation's flags come from the carrier and read as if from any origin: UPS Standard is
// "domestic", but from a US address UPS only offers it to Canada and Mexico, so a US order asked
// for it is refused. Keyed by the carrier's own code and the service code; only entries we're sure
// of, since a wrong note misleads more than none.
const notes: Partial<Record<ProviderId, Record<string, Record<string, ServiceNote>>>> = {
  SHIPSTATION: {
    ups: {
      ups_standard: "usCanadaMexico",
      ups_express: "internationalOnly",
      ups_express_plus: "internationalOnly",
      ups_express_noon: "internationalOnly",
      ups_worldwide_expedited: "internationalOnly",
      ups_worldwide_saver: "internationalOnly",
      ups_express_early_am: "intoUs",
    },
  },
};

export function serviceNote(
  provider: ProviderId,
  carrierCode: string,
  serviceCode: string,
): ServiceNote | null {
  return notes[provider]?.[carrierCode]?.[serviceCode] ?? null;
}
