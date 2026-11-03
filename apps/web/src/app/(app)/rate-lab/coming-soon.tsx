import { getTranslations } from "next-intl/server";

/** A tab whose ticket hasn't shipped yet. */
export async function ComingSoon() {
  const t = await getTranslations();
  return <p className="text-base-content/70">{t("rateLab.comingSoon")}</p>;
}
