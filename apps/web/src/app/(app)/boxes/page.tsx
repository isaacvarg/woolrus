import { getTranslations } from "next-intl/server";
import { BoxesManager } from "./boxes-manager";

export default async function BoxesPage() {
  const t = await getTranslations("boxes");
  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-3xl font-bold">{t("title")}</h1>
      <BoxesManager />
    </section>
  );
}
