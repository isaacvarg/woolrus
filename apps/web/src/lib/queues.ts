import type { QueueStage } from "@woolrus/contracts";

/** The floor queues in nav order, with their URL slug (`/queue/on-hold`) and nav message key. */
export const queues = [
  { stage: "PENDING", slug: "pending", label: "nav.pending" },
  { stage: "PICKING", slug: "picking", label: "nav.picking" },
  { stage: "PACKING", slug: "packing", label: "nav.packing" },
  { stage: "QA", slug: "qa", label: "nav.qa" },
  { stage: "READY", slug: "ready", label: "nav.ready" },
  { stage: "ON_HOLD", slug: "on-hold", label: "nav.onHold" },
] as const satisfies readonly { stage: QueueStage; slug: string; label: string }[];

export type Queue = (typeof queues)[number];

export function queueBySlug(slug: string): Queue | undefined {
  return queues.find((queue) => queue.slug === slug);
}
