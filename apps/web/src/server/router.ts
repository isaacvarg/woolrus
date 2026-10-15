import {
  archiveBox,
  clearSecret,
  createBox,
  getOrder,
  getOrderHistory,
  getPublicSettings,
  getSettings,
  listBoxes,
  listOrders,
  listQueue,
  orderMutations,
  permissionsFor,
  queueCounts,
  setSecret,
  updateSettings,
} from "@woolrus/core";
import { db } from "@woolrus/db";
import { api } from "./orpc";

// Thin by design: parse (done by the contract), call core, return. No rules live here.
export const router = api.router({
  me: {
    get: api.me.get.handler(({ context: { user, actor } }) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      roles: user.roles,
      permissions: permissionsFor(user.roles),
      locale: user.locale,
      theme: user.theme,
      stationId: actor.stationId,
    })),
  },
  boxes: {
    list: api.boxes.list.handler(({ input, context }) => listBoxes(db, context.actor, input)),
    create: api.boxes.create.handler(({ input, context }) => createBox(db, context.actor, input)),
    archive: api.boxes.archive.handler(({ input, context }) =>
      archiveBox(db, context.actor, input),
    ),
  },
  settings: {
    get: api.settings.get.handler(({ context }) => getSettings(db, context.actor)),
    public: api.settings.public.handler(({ context }) => getPublicSettings(db, context.actor)),
    update: api.settings.update.handler(({ input, context }) =>
      updateSettings(db, context.actor, input),
    ),
    setSecret: api.settings.setSecret.handler(({ input, context }) =>
      setSecret(db, context.actor, input),
    ),
    clearSecret: api.settings.clearSecret.handler(({ input, context }) =>
      clearSecret(db, context.actor, input),
    ),
  },
  orders: {
    queue: api.orders.queue.handler(({ input, context }) => listQueue(db, context.actor, input)),
    counts: api.orders.counts.handler(({ context }) => queueCounts(db, context.actor)),
    list: api.orders.list.handler(({ input, context }) => listOrders(db, context.actor, input)),
    get: api.orders.get.handler(({ input, context }) => getOrder(db, context.actor, input)),
    history: api.orders.history.handler(({ input, context }) =>
      getOrderHistory(db, context.actor, input),
    ),
    beginPicking: api.orders.beginPicking.handler(({ input, context }) =>
      orderMutations.beginPicking(db, context.actor, input),
    ),
    completePicking: api.orders.completePicking.handler(({ input, context }) =>
      orderMutations.completePicking(db, context.actor, input),
    ),
    completePacking: api.orders.completePacking.handler(({ input, context }) =>
      orderMutations.completePacking(db, context.actor, input),
    ),
    completeQa: api.orders.completeQa.handler(({ input, context }) =>
      orderMutations.completeQa(db, context.actor, input),
    ),
    hold: api.orders.hold.handler(({ input, context }) =>
      orderMutations.hold(db, context.actor, input),
    ),
    resume: api.orders.resume.handler(({ input, context }) =>
      orderMutations.resume(db, context.actor, input),
    ),
    cancel: api.orders.cancel.handler(({ input, context }) =>
      orderMutations.cancel(db, context.actor, input),
    ),
    forceStatus: api.orders.forceStatus.handler(({ input, context }) =>
      orderMutations.forceStatus(db, context.actor, input),
    ),
    claim: api.orders.claim.handler(({ input, context }) =>
      orderMutations.claim(db, context.actor, input),
    ),
    release: api.orders.release.handler(({ input, context }) =>
      orderMutations.release(db, context.actor, input),
    ),
    takeOver: api.orders.takeOver.handler(({ input, context }) =>
      orderMutations.takeOver(db, context.actor, input),
    ),
    claimMany: api.orders.claimMany.handler(({ input, context }) =>
      orderMutations.claimMany(db, context.actor, input),
    ),
  },
});

export type Router = typeof router;
