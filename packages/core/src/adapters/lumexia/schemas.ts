import { z } from "zod";
import { LumexiaBadResponse } from "./errors";

// The wire shapes of Lumexia's REST API v1 (docs/lumexia-api.md). Unknown fields are dropped, so
// Lumexia can add some without breaking us. Ids are opaque strings: never parsed as UUIDs here.

const timestamp = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const lumexiaTypeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  archived: z.boolean(),
});

export const lumexiaInventoryTypeSchema = lumexiaTypeSchema.extend({ isTracked: z.boolean() });

export const lumexiaItemSchema = z.object({
  id: z.string().min(1),
  referenceCode: z.string().min(1),
  name: z.string(),
  aliases: z.array(z.string()),
  // Required in Lumexia, so set in practice, but its schema allows null.
  itemTypeId: z.string().min(1).nullable(),
  procurementTypeId: z.string().min(1).nullable(),
  inventoryTypeId: z.string().min(1).nullable(),
  archived: z.boolean(),
  updatedAt: timestamp,
});

export const lumexiaLotSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  lotNumber: z.string().min(1),
  archived: z.boolean(),
  createdAt: timestamp,
});

export const lumexiaHealthSchema = z.object({
  ok: z.literal(true),
  apiVersion: z.string(),
  key: z.object({ userId: z.string(), scopes: z.array(z.string()) }),
});

export const lumexiaErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** One of Lumexia's type tables. `isTracked` is only on inventory types. */
export type LumexiaType = { id: string; name: string; archived: boolean; isTracked?: boolean };
export type LumexiaItem = z.output<typeof lumexiaItemSchema>;
export type LumexiaLot = z.output<typeof lumexiaLotSchema>;

/** As Lumexia sends them: what fixtures and the fake hold. */
export type RawLumexiaType =
  | z.input<typeof lumexiaInventoryTypeSchema>
  | z.input<typeof lumexiaTypeSchema>;
export type RawLumexiaItem = z.input<typeof lumexiaItemSchema>;
export type RawLumexiaLot = z.input<typeof lumexiaLotSchema>;

/** Parses `value`, or throws `LumexiaBadResponse` naming the failing path (never the values). */
export function parseLumexia<T extends z.ZodType>(
  schema: T,
  value: unknown,
  what: string,
): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const where = result.error.issues
    .slice(0, 3)
    .map((issue) => issue.path.join(".") || "(root)")
    .join(", ");
  throw new LumexiaBadResponse(`${what}: unexpected shape at ${where}`);
}

/** A list route's `{ "<key>": [...], "nextCursor" }`; the rows are parsed one by one afterwards. */
export function parseLumexiaPage(
  value: unknown,
  key: string,
  what: string,
): { rows: unknown[]; nextCursor: string | null } {
  const schema = z.object({
    [key]: z.array(z.unknown()),
    nextCursor: z.string().min(1).nullable(),
  });
  const body = parseLumexia(schema, value, what) as Record<string, unknown>;
  return { rows: body[key] as unknown[], nextCursor: body.nextCursor as string | null };
}

export const parseLumexiaType = (value: unknown, inventory: boolean): LumexiaType =>
  inventory
    ? parseLumexia(lumexiaInventoryTypeSchema, value, "inventory type")
    : parseLumexia(lumexiaTypeSchema, value, "type");
export const parseLumexiaItem = (value: unknown): LumexiaItem =>
  parseLumexia(lumexiaItemSchema, value, "item");
export const parseLumexiaLot = (value: unknown): LumexiaLot =>
  parseLumexia(lumexiaLotSchema, value, "lot");
