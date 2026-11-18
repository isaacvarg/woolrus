import { getTranslations } from "next-intl/server";

/** A tab whose report hasn't landed yet. */
export async function ComingSoon() {
  const t = await getTranslations();
  return (
    <p className="rounded-box bg-base-100 p-4 text-base-content/70 shadow-sm">
      {t("reports.comingSoon")}
    </p>
  );
}
