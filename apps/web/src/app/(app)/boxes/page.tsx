import { can } from "@woolrus/core";
import { getTranslations } from "next-intl/server";
import { currentActor } from "@/server/actor";
import { BoxesManager } from "./boxes-manager";

export default async function BoxesPage() {
  const t = await getTranslations("boxes");
  const actor = await currentActor();
  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">{t("title")}</h1>
      {/* Only for showing the controls; the API checks it again. */}
      <BoxesManager canManage={actor ? can(actor, "box.manage") : false} />
    </section>
  );
}
