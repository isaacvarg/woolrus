import { implement, ORPCError, ValidationError } from "@orpc/server";
import { contract, toFieldErrors } from "@woolrus/contracts";
import { type Actor, AppError } from "@woolrus/core";
import { db } from "@woolrus/db";
import type { Logger } from "@woolrus/logger";
import { auth } from "./auth";

export type BaseContext = {
  headers: Headers;
  log: Logger;
};

const os = implement(contract).$context<BaseContext>();

/**
 * Turns domain AppErrors and contract input-validation failures into typed API errors carrying
 * i18n message keys. Input validation runs after this middleware, so its error passes through here.
 */
const mapErrors = os.middleware(async ({ next, context }) => {
  try {
    return await next();
  } catch (error) {
    // Only input failures: output validation also throws ValidationError, but as a 500 (our bug).
    if (
      error instanceof ORPCError &&
      error.code === "BAD_REQUEST" &&
      error.cause instanceof ValidationError
    ) {
      throw new ORPCError("BAD_REQUEST", {
        data: { messageKey: "errors.validation", fields: toFieldErrors(error.cause.issues) },
      });
    }
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
