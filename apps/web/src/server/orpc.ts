import { implement, ORPCError, ValidationError } from "@orpc/server";
import type { ResponseHeadersPluginContext } from "@orpc/server/plugins";
import { contract, toFieldErrors } from "@woolrus/contracts";
import { AppError } from "@woolrus/core";
import type { Logger } from "@woolrus/logger";
import { resolveActor } from "./actor";

export type BaseContext = ResponseHeadersPluginContext & {
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
        data: {
          messageKey: error.messageKey,
          fields: error.fields,
          params: error.params,
          unmet: error.unmet ? [...error.unmet] : undefined,
          failures: error.failures ? [...error.failures] : undefined,
        },
      });
    }
    if (!(error instanceof ORPCError)) context.log.error({ err: error }, "unhandled API error");
    throw error;
  }
});

/**
 * Deny by default (NFR-SEC-01): every procedure goes through `authed`, which resolves the
 * request to an active user's Actor (see `resolveActor`).
 */
const authed = os.middleware(async ({ next, context }) => {
  const resolved = await resolveActor(context.headers);
  if (!resolved) {
    throw new ORPCError("UNAUTHORIZED", { data: { messageKey: "errors.unauthenticated" } });
  }
  const { actor, user } = resolved;
  return next({ context: { actor, user, log: context.log.child({ userId: user.id }) } });
});

export const api = os.use(mapErrors).use(authed);
