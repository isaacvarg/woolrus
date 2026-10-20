"use client";

import { ORPCError } from "@orpc/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "@/components/ui/toast";

/**
 * A station whose user's turn ended on the server (idle lock, or Lock pressed in another tab)
 * answers `errors.station.locked`: show its lock screen. A full load drops that user's cache.
 */
function showLockScreenIfLocked(error: unknown) {
  const data = error instanceof ORPCError ? (error.data as { messageKey?: unknown }) : undefined;
  if (data?.messageKey === "errors.station.locked") window.location.assign("/station");
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 10_000 } },
        queryCache: new QueryCache({ onError: showLockScreenIfLocked }),
        mutationCache: new MutationCache({ onError: showLockScreenIfLocked }),
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}
