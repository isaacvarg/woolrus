import QRCode from "qrcode";

/**
 * The badge's QR code as SVG, rendered here so the code never travels in a URL to an image
 * endpoint (SPEC-identity decision 5). Level Q survives ~25% damage; the uppercase Crockford code
 * fits QR's compact alphanumeric mode.
 */
export function badgeQrSvg(code: string): Promise<string> {
  return QRCode.toString(code, { type: "svg", errorCorrectionLevel: "Q", margin: 2 });
}
