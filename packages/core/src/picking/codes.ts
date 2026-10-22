// Code matching (SPEC-picking "Code matching", FR-PICK-06): what a scanner can type for a line.
// Codes compare trimmed and upper-cased, so "lav-8oz " from a label matches SKU "LAV-8OZ".

type Codes = { barcode: string | null; sku: string | null };

export type CodedLine = {
  sku: string | null;
  product: Codes | null;
  variation: Codes | null;
};

/**
 * The characters JavaScript's `trim` strips (whitespace and line terminators). SQL compares stored
 * codes with `btrim(code, CODE_PADDING)`, since its plain `trim` strips only spaces.
 */
export const CODE_PADDING =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
  "\u2028\u2029\u202f\u205f\u3000\ufeff";

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
