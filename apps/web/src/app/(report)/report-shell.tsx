"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { ChartAnimation } from "@/components/charts/theme";
import { Button } from "@/components/ui/fields";

/** Charts size themselves to their box after the first paint; print once they have. */
const CHARTS_SETTLE_MS = 500;

/**
 * A report's title, the print button (not printed) and, with `autoPrint`, the print dialog once
 * the data is in. The page is light whatever the user's theme, charts included: they read the
 * theme from `<html>`, so it's switched there while the report is open. Charts don't animate.
 */
export function ReportShell({
  title,
  subtitle,
  ready,
  error,
  autoPrint,
  children,
}: {
  title: string;
  subtitle?: string;
  ready: boolean;
  error?: string;
  autoPrint: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("rateLab.report");
  const format = useFormatter();
  // Set once mounted, so the server's render and the browser's agree.
  const [now, setNow] = useState<Date | null>(null);
  const printed = useRef(false);

  useEffect(() => {
    setNow(new Date());
    const html = document.documentElement;
    const theme = html.getAttribute("data-theme");
    html.setAttribute("data-theme", "light");
    return () => {
      if (theme === null) html.removeAttribute("data-theme");
      else html.setAttribute("data-theme", theme);
    };
  }, []);

  useEffect(() => {
    if (!ready || !autoPrint || printed.current) return;
    printed.current = true;
    const timer = window.setTimeout(() => window.print(), CHARTS_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [ready, autoPrint]);

  return (
    <ChartAnimation value={false}>
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <p className="text-sm opacity-70">{t("printHint")}</p>
        <Button className="btn-primary ms-auto" onPress={() => window.print()}>
          {t("print")}
        </Button>
      </div>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p>{subtitle}</p>}
        {now && (
          <p className="text-sm opacity-70">
            {t("printedAt", {
              at: format.dateTime(now, { dateStyle: "medium", timeStyle: "short" }),
            })}
          </p>
        )}
      </header>
      {error ? <Forbidden message={error} /> : ready ? children : <p>{t("loading")}</p>}
    </ChartAnimation>
  );
}

/** A report section that starts a new printed page. */
export function PageSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 print:break-before-page">
      <h2 className="text-xl font-semibold">{title}</h2>
      {hint && <p className="text-sm opacity-70">{hint}</p>}
      {children}
    </section>
  );
}

export function Forbidden({ message }: { message: string }) {
  return (
    <p role="alert" className="alert alert-error">
      {message}
    </p>
  );
}
