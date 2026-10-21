// Code matching (SPEC-picking "Code matching", FR-PICK-06): what a scanner can type for a line.
// Codes compare trimmed and upper-cased, so "lav-8oz " from a label matches SKU "LAV-8OZ".

type Codes = { barcode: string | null; sku: string | null };

export type CodedLine = {
  sku: string | null;
  product: Codes | null;
  variation: Codes | null;
};

export const normalizeCode = (code: string) => code.trim().toUpperCase();

/** The codes that pick this line: variation and product barcodes and SKUs, and the line's own SKU. */
export function codesForLine(line: CodedLine): Set<string> {
  const raw = [
    line.variation?.barcode,
    line.product?.barcode,
    line.variation?.sku,
    line.product?.sku,
    line.sku,
  ];
  return new Set(raw.map((c) => normalizeCode(c ?? "")).filter((c) => c !== ""));
}
