// Lot codes (SPEC-lumexia "Lot numbers and scans"). Pure, and exported as `@woolrus/core/lot-codes`
// so the pack screen can route a scan without a round trip.
//
// A printed lot number is `<item reference code>.<letter><2 digits><month A–L><DD><YY>`, e.g.
// `BASE1234.A12A0124`; the label's QR code holds the lot's UUID instead. A product barcode or SKU
// can't look like either, so routing a scan is never ambiguous.

export type LotCode =
  | { kind: "number"; lotNumber: string; referenceCode: string }
  | { kind: "uuid"; id: string };

const LOT_NUMBER = /^([A-Z0-9-]+)\.([A-Z]\d{2}[A-L]\d{4})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A lot number (with its item's reference code split out), a lot UUID, or null for anything else. */
export function parseLotCode(raw: string): LotCode | null {
  const code = raw.trim().toUpperCase();
  const number = LOT_NUMBER.exec(code);
  if (number) return { kind: "number", lotNumber: code, referenceCode: number[1] as string };
  if (UUID.test(code)) return { kind: "uuid", id: code.toLowerCase() };
  return null;
}

export const isLotCode = (raw: string) => parseLotCode(raw) !== null;

/** What a lot chip shows: the number without the reference code ("A12A0124"), which the card already names. */
export function lotLabel(lotNumber: string): string {
  const dot = lotNumber.lastIndexOf(".");
  return dot === -1 ? lotNumber : lotNumber.slice(dot + 1);
}
