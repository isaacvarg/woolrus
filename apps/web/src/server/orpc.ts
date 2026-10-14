import { implement, ORPCError } from "@orpc/server";
import { contract } from "@woolrus/contracts";
import { type Actor, AppError } from "@woolrus/core";
import { db } from "@woolrus/db";
import type { Logger } from "@woolrus/logger";
import { auth } from "./auth";

export type BaseContext = {
  headers: Headers;
  log: Logger;
};

const os = implement(contract).$context<BaseContext>();

/** Turns domain AppErrors into typed API errors carrying an i18n message key. */
const mapErrors = os.middleware(async ({ next, context }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof AppError) {
      throw new ORPCError(error.kind, {
        data: { messageKey: error.messageKey, fields: error.fields },
      });
    }
    if (!(error instanceof ORPCError)) context.log.error({ err: error }, "unhandled API error");
    throw error;
  }
});

/**
 * Deny by default (NFR-SEC-01): every procedure goes through `authed`, which resolves the
 * session (cookie or bearer token) to an active user and builds the Actor.
 */
const authed = os.middleware(async ({ next, context }) => {
  const session = await auth().api.getSession({ headers: context.headers });
  const user = session ? await db.user.findUnique({ where: { id: session.user.id } }) : null;
  if (!user?.active) {
    throw new ORPCError("UNAUTHORIZED", { data: { messageKey: "errors.unauthenticated" } });
  }
  const actor: Actor = { userId: user.id, roles: user.roles, stationId: null };
  return next({ context: { actor, user, log: context.log.child({ userId: user.id }) } });
});

export const api = os.use(mapErrors).use(authed);
