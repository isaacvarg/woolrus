import { isQueryTrue } from "@woolrus/contracts";
import { can, ruleFor } from "@woolrus/core";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { queueBySlug } from "@/lib/queues";
import { currentActor } from "@/server/actor";
import { QueueTable } from "./queue-table";

export default async function QueuePage({ params, searchParams }: PageProps<"/queue/[stage]">) {
  const queue = queueBySlug((await params).stage);
  // `?late=1`: the dashboard's SLA alert links here for the orders past their SLA only.
  const lateOnly = isQueryTrue((await searchParams).late);
  if (!queue) notFound();
  const t = await getTranslations();
  const actor = await currentActor();

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">{t(queue.label)}</h1>
      <QueueTable
        stage={queue.stage}
        slug={queue.slug}
        lateOnly={lateOnly}
        userId={actor?.userId ?? null}
        // Only decides whether to show the button; the API checks again.
        canBeginPicking={!!actor && can(actor, ruleFor("beginPicking").permission)}
        canPack={!!actor && can(actor, "order.pack")}
        canQa={!!actor && can(actor, "order.qa")}
        canPrint={!!actor && can(actor, "label.print")}
        canShip={!!actor && can(actor, "order.ship")}
        canRepack={!!actor && can(actor, "order.repack")}
      />
    </section>
  );
}
