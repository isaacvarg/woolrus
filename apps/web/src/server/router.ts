import {
  archiveBox,
  clearSecret,
  createBox,
  createPriorityRule,
  deletePriorityRule,
  getEmailSender,
  getOrder,
  getOrderHistory,
  getPublicSettings,
  getSettings,
  getSyncStatus,
  listBoxes,
  listOrders,
  listPriorityRules,
  listQueue,
  listSyncRunErrors,
  listSyncRuns,
  orderMutations,
  permissionsFor,
  queueCounts,
  reorderPriorityRules,
  requestSync,
  sendTestEmail,
  setSecret,
  testStoreConnection,
  updatePriorityRule,
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
    // The admin is waiting: give up after 10 s rather than Resend's default 30.
    sendTestEmail: api.settings.sendTestEmail.handler(({ context }) =>
      sendTestEmail(db, context.actor, (db) =>
        getEmailSender(db, {
          timeoutMs: 10_000,
          log: (entry) => context.log.warn(entry, "test email logged, not sent: no Resend key"),
        }),
      ),
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
    externalChange: {
      apply: api.orders.externalChange.apply.handler(({ input, context }) =>
        orderMutations.applyExternalChange(db, context.actor, input),
      ),
      dismiss: api.orders.externalChange.dismiss.handler(({ input, context }) =>
        orderMutations.dismissExternalChange(db, context.actor, input),
      ),
    },
    claimMany: api.orders.claimMany.handler(({ input, context }) =>
      orderMutations.claimMany(db, context.actor, input),
    ),
  },
  sync: {
    status: api.sync.status.handler(({ context }) => getSyncStatus(db, context.actor)),
    runs: api.sync.runs.handler(({ input, context }) => listSyncRuns(db, context.actor, input)),
    runErrors: api.sync.runErrors.handler(({ input, context }) =>
      listSyncRunErrors(db, context.actor, input),
    ),
    run: api.sync.run.handler(({ input, context }) => requestSync(db, context.actor, input)),
    testConnection: api.sync.testConnection.handler(({ context }) =>
      testStoreConnection(db, context.actor),
    ),
  },
  priorityRules: {
    list: api.priorityRules.list.handler(({ context }) => listPriorityRules(db, context.actor)),
    create: api.priorityRules.create.handler(({ input, context }) =>
      createPriorityRule(db, context.actor, input),
    ),
    update: api.priorityRules.update.handler(({ input, context }) =>
      updatePriorityRule(db, context.actor, input),
    ),
    delete: api.priorityRules.delete.handler(({ input, context }) =>
      deletePriorityRule(db, context.actor, input),
    ),
    reorder: api.priorityRules.reorder.handler(({ input, context }) =>
      reorderPriorityRules(db, context.actor, input),
    ),
  },
});

export type Router = typeof router;
