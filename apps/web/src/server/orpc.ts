import { implement, ORPCError, ValidationError } from "@orpc/server";
import type { ResponseHeadersPluginContext } from "@orpc/server/plugins";
import { contract, toFieldErrors } from "@woolrus/contracts";
import { AppError } from "@woolrus/core";
import type { Logger } from "@woolrus/logger";
import { resolveActor, resolveStationDevice } from "./actor";
import { captureServerError } from "./error-reporting";
import { type RequestTrace, requestIdOf } from "./request-trace";
import { clearStationCookie } from "./station-cookie";

export type BaseContext = ResponseHeadersPluginContext & {
  headers: Headers;
  log: Logger;
  /** Filled in by `authed` so the request log line can name the user. */
  trace: RequestTrace;
};

const os = implement(contract).$context<BaseContext>();

/**
 * Turns domain AppErrors and contract input-validation failures into typed API errors carrying
 * i18n message keys. Input validation runs after this middleware, so its error passes through here.
 */
export const mapErrors = os.middleware(async ({ next, context }) => {
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
          canLink: error.canLink,
        },
      });
    }
    if (!(error instanceof ORPCError)) {
      context.log.error({ err: error }, "unhandled API error");
      captureServerError(error, {
        requestId: requestIdOf(context.headers),
        userId: context.trace.userId,
        stationId: context.trace.stationId,
      });
    }
    throw error;
  }
});

/**
 * Deny by default (NFR-SEC-01): every procedure goes through `authed`, which resolves the
 * request to an active user's Actor, personal or at a station (see `resolveActor`).
 */
const authed = os.middleware(async ({ next, context }) => {
  const resolved = await resolveActor(context.headers);
  if (!resolved) {
    // A station device with nobody unlocked: the client shows the lock screen, not sign-in.
    const device = await resolveStationDevice(context.headers);
    if (device.kind === "station") {
      throw new ORPCError("UNAUTHORIZED", { data: { messageKey: "errors.station.locked" } });
    }
    if (device.kind === "stale") context.resHeaders?.append("Set-Cookie", clearStationCookie());
    throw new ORPCError("UNAUTHORIZED", { data: { messageKey: "errors.unauthenticated" } });
  }
  const { actor, user, station, idleLockAt } = resolved;
  context.trace.userId = user.id;
  context.trace.stationId = actor.stationId ?? undefined;
  const log = context.log.child({ userId: user.id, stationId: actor.stationId ?? undefined });
  return next({ context: { actor, user, station, idleLockAt, log } });
});

export const api = os.use(mapErrors).use(authed);

/**
 * For the station device itself (status, unlock): a valid station cookie, and no unlocked user
 * needed. A revoked station's cookie is cleared.
 */
const stationDevice = os.middleware(async ({ next, context }) => {
  const device = await resolveStationDevice(context.headers);
  if (device.kind !== "station") {
    if (device.kind === "stale") context.resHeaders?.append("Set-Cookie", clearStationCookie());
    throw new ORPCError("UNAUTHORIZED", { data: { messageKey: "errors.station.unknown" } });
  }
  return next({ context: { station: device.station } });
});

export const stationApi = os.use(mapErrors).use(stationDevice);

/**
 * The top-level router adds no middleware: each procedure brings its own (`api` or `stationApi`).
 * `api.router` would put `authed` in front of the station procedures too.
 */
export const implementer = os;
