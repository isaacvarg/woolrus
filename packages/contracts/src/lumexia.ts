import { z } from "zod";
import { base } from "./base";

// Lumexia's API (SPEC-lumexia). Nothing here carries the API key or Lumexia's URL.

/** Test connection: health's three states, with the reason when it isn't ok. */
export const LumexiaConnectionResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }),
  z.object({ status: z.enum(["unconfigured", "down"]), messageKey: z.string() }),
]);
export type LumexiaConnectionResult = z.infer<typeof LumexiaConnectionResult>;

export const lumexia = {
  testConnection: base
    .route({
      method: "POST",
      path: "/lumexia/test-connection",
      tags: ["Lumexia"],
      summary: "Check the saved Lumexia URL and API key",
    })
    .output(LumexiaConnectionResult),
};
