import { Id } from "@woolrus/contracts";
import { notFound } from "next/navigation";
import { BatchScreen } from "./batch-screen";

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Id.safeParse((await params).id);
  if (!id.success) notFound();
  return <BatchScreen batchId={id.data} />;
}
