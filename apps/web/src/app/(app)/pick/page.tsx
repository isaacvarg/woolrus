import { getTranslations } from "next-intl/server";
import { MyPicks } from "./my-picks";

export default async function MyPicksPage() {
  const t = await getTranslations();
  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-3xl font-bold">{t("myPicks.title")}</h1>
      <MyPicks />
    </section>
  );
}
