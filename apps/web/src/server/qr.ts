import QRCode from "qrcode";

/**
 * Any short text as a QR code in SVG, rendered here so the text (a badge code, a setup link) never
 * travels in a URL to an image endpoint (SPEC-identity decision 5). Level Q survives ~25% damage.
 * Badge codes are uppercase Crockford, which fits QR's compact alphanumeric mode.
 */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", errorCorrectionLevel: "Q", margin: 2 });
}
