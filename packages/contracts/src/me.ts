import { z } from "zod";
import { base, Id } from "./base";

export const Role = z.enum(["ADMIN", "PICKER", "PACKER", "QA", "SHIPPER"]);
export type Role = z.infer<typeof Role>;

export const Me = z.object({
  id: Id,
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  roles: z.array(Role),
  permissions: z.array(z.string()),
  locale: z.enum(["en", "es"]),
  theme: z.enum(["SYSTEM", "LIGHT", "DARK", "HIGH_CONTRAST"]),
  stationId: Id.nullable(),
});
export type Me = z.infer<typeof Me>;

export const me = {
  get: base
    .route({ method: "GET", path: "/me", tags: ["Me"], summary: "The signed-in user" })
    .output(Me),
};
