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

function leaveIfSignedOut(error: unknown) {
  const key =
    error instanceof ORPCError ? (error.data as { messageKey?: unknown })?.messageKey : undefined;
  const exit = typeof key === "string" ? exits[key] : undefined;
  if (exit) window.location.assign(exit);
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 10_000 } },
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
