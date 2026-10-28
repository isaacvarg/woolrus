import { can, ruleFor } from "@woolrus/core";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { queueBySlug } from "@/lib/queues";
import { currentActor } from "@/server/actor";
import { QueueTable } from "./queue-table";

export default async function QueuePage({ params }: { params: Promise<{ stage: string }> }) {
  const queue = queueBySlug((await params).stage);
  if (!queue) notFound();
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">{t(queue.label)}</h1>
      <QueueTable
        stage={queue.stage}
        userId={actor?.userId ?? null}
        // Only decides whether to show the button; the API checks again.
        canBeginPicking={!!actor && can(actor, ruleFor("beginPicking").permission)}
        canPack={!!actor && can(actor, "order.pack")}
        canQa={!!actor && can(actor, "order.qa")}
      />
    </section>
  );
}
