"use client";

import { ORPCError } from "@orpc/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "@/components/ui/toast";

/**
 * Leaves a page whose actor is gone, with a full load so no cached data survives: a station whose
 * user's turn ended on the server (idle lock, or Lock in another tab) answers
 * `errors.station.locked` and shows its lock screen; a user signed out or deactivated elsewhere
 * answers `errors.unauthenticated` and goes to sign-in (SPEC-identity success criterion 13); a
 * station revoked under its open lock screen answers `errors.station.unknown` and forgets itself.
 */
const exits: Record<string, string> = {
  "errors.station.locked": "/station",
  "errors.unauthenticated": "/sign-in",
  "errors.station.unknown": "/station/forget",
};

function exitFor(error: unknown): string | undefined {
  const key =
    error instanceof ORPCError ? (error.data as { messageKey?: unknown })?.messageKey : undefined;
  return typeof key === "string" ? exits[key] : undefined;
}

function leaveIfSignedOut(error: unknown) {
  const exit = exitFor(error);
  if (exit) window.location.assign(exit);
}

/**
 * Retries a failed query up to 3 times, but never one whose actor is gone: that won't change, and
 * the error must reach `leaveIfSignedOut` now. Otherwise each order event refetching the query
 * would restart its retries, and a busy floor would keep a deactivated user's page open.
 */
const retry = (failures: number, error: unknown) => !exitFor(error) && failures < 3;

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 10_000, retry } },
        queryCache: new QueryCache({ onError: leaveIfSignedOut }),
        mutationCache: new MutationCache({ onError: leaveIfSignedOut }),
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}
