import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { contract } from "@woolrus/contracts";

const link = new RPCLink({
  url: () => `${typeof window === "undefined" ? "http://localhost" : window.location.origin}/rpc`,
});

/** Typed API client. Used from client components only; server components call @woolrus/core directly. */
export const client: ContractRouterClient<typeof contract> = createORPCClient(link);

/** TanStack Query helpers: `useQuery(orpc.boxes.list.queryOptions({ input }))`. */
export const orpc = createTanstackQueryUtils(client);
