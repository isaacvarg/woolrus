import { useTranslations } from "next-intl";

// **PDF report** (SPEC-rate-lab "Exports", decision 10): opens the print-ready page in a new tab,
// which calls the browser's print dialog once it has loaded (`print=1`). Saving the PDF is the
// browser's "Save as PDF".

type Value = string | string[] | number | boolean | undefined;

/** A report's filters as a query string: lists repeat their key, `true` is `1`, blanks are left out. */
export function reportQuery(values: Record<string, Value>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) for (const item of value) query.append(key, item);
    else if (value === true) query.set(key, "1");
    else if (typeof value === "number" || (typeof value === "string" && value))
      query.set(key, String(value));
  }
  return query.toString();
}

export function ReportLink({ href, className = "" }: { href: string; className?: string }) {
  const t = useTranslations("rateLab.report");
  const url = `${href}${href.includes("?") ? "&" : "?"}print=1`;
  return (
    <a href={url} target="_blank" rel="noopener" className={`btn btn-outline ${className}`}>
      {t("pdfReport")}
    </a>
  );
}
