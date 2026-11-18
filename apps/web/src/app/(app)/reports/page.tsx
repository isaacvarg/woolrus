import type { Route } from "next";
import { redirect } from "next/navigation";

/** Throughput is the first tab; the range and filters in the query come along. */
export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      if (one !== undefined) params.append(key, one);
    }
  }
  const search = params.toString();
  redirect(`/reports/throughput${search ? `?${search}` : ""}` as Route);
}
