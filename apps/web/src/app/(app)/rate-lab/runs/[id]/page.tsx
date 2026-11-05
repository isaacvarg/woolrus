import { Id } from "@woolrus/contracts";
import { notFound } from "next/navigation";
import { RunDetail } from "./run-detail";

export default async function RateLabRunPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Id.safeParse((await params).id);
  if (!id.success) notFound();
  return <RunDetail runId={id.data} />;
}
