import {
  addPackage,
  archiveBox,
  clearPin,
  clearProviderCredentials,
  clearSecret,
  completeBatchMembers,
  completePack,
  completePick,
  createBatch,
  createBox,
  createInvitation,
  createNote,
  createPriorityRule,
  deactivateUser,
  deleteBox,
  deleteIssue,
  deleteNote,
  deletePackage,
  deletePriorityRule,
  finishBatch,
  getBatch,
  getEmailSender,
  getIssue,
  getOrder,
  getOrderHistory,
  getOrderShipping,
  getPackView,
  getPickView,
  getPublicSettings,
  getSettings,
  getSyncStatus,
  issueAssignees,
  issueBadge,
  issueCounts,
  keepOriginalAddress,
  linkBarcode,
  listBoxes,
  listInvitations,
  listIssues,
  listNotes,
  listOrders,
  listPriorityRules,
  listProviders,
  listQueue,
  listShippingConfig,
  listStations,
  listSyncRunErrors,
  listSyncRuns,
  listUsers,
  listVoids,
  lockStation,
  markOutOfStock,
  myPicks,
  orderMutations,
  packRemaining,
  packUnits,
  permissionsFor,
  pickLine,
  queueCounts,
  reactivateUser,
  recheckAddress,
  refreshRates,
  registerStation,
  removeFromBatch,
  renameStation,
  reopenIssue,
  reorderPriorityRules,
  reportIssue,
  requestSync,
  resendInvitation,
  resolveIssue,
  resolveVoids,
  restoreBox,
  revokeBadge,
  revokeInvitation,
  revokeStation,
  scan,
  scanBatch,
  scanIntoPackage,
  sendTestEmail,
  setCarrierEnabled,
  setCarrierLabel,
  setPackageBox,
  setPin,
  setProviderCredentials,
  setProviderEnabled,
  setResponsible,
  setSecret,
  setServiceEnabled,
  setWeight,
  stationStatus,
  substitute,
  syncCarriers,
  testProvider,
  testStoreConnection,
  touchStation,
  undoVoid,
  unlockWithBadge,
  unlockWithPin,
  unpackUnits,
  unpickLine,
  updateBox,
  updateIssue,
  updateNote,
  updatePreferences,
  updatePriorityRule,
  updateProviderConfig,
  updateSettings,
  updateUserRoles,
  voidCounts,
  voidItem,
} from "@woolrus/core";
import { db } from "@woolrus/db";
import { createLogger } from "@woolrus/logger";
import { preferenceCookie } from "@/lib/preferences";
import { auth } from "./auth";
import { badgeQrSvg } from "./badge";
import { env } from "./env";
import { api, type BaseContext, implementer, stationApi } from "./orpc";
import { stationCookie } from "./station-cookie";
import { storage } from "./storage";

const log = createLogger({ module: "router" });

/** Signs out the request's Better Auth session, if any, passing its cookie-clearing headers on. */
async function endPersonalSession(context: BaseContext): Promise<void> {
  if (!(await auth().api.getSession({ headers: context.headers }))) return;
  const signedOut = await auth().api.signOut({ headers: context.headers, returnHeaders: true });
  for (const cookie of signedOut.headers.getSetCookie()) {
    context.resHeaders?.append("Set-Cookie", cookie);
  }
}

// Thin by design: parse (done by the contract), call core, return. No rules live here.
export const router = implementer.router({
  me: {
    get: api.me.get.handler(({ context: { user, actor, station, idleLockAt } }) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      roles: user.roles,
      permissions: permissionsFor(user.roles),
      locale: user.locale,
      theme: user.theme,
      sidebarCollapsed: user.sidebarCollapsed,
      stationId: actor.stationId,
      stationName: station?.name ?? null,
      idleLockAt,
    })),
    updatePreferences: api.me.updatePreferences.handler(async ({ input, context }) => {
      const preferences = await updatePreferences(db, context.actor, input);
      context.resHeaders?.append("Set-Cookie", preferenceCookie("locale", preferences.locale));
      context.resHeaders?.append("Set-Cookie", preferenceCookie("theme", preferences.theme));
      return preferences;
    }),
  },
  boxes: {
    list: api.boxes.list.handler(({ input, context }) => listBoxes(db, context.actor, input)),
    create: api.boxes.create.handler(({ input, context }) => createBox(db, context.actor, input)),
    archive: api.boxes.archive.handler(({ input, context }) =>
      archiveBox(db, context.actor, input),
    ),
    update: api.boxes.update.handler(({ input, context }) => updateBox(db, context.actor, input)),
    restore: api.boxes.restore.handler(({ input, context }) =>
      restoreBox(db, context.actor, input),
    ),
    delete: api.boxes.delete.handler(({ input, context }) => deleteBox(db, context.actor, input)),
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
  notes: {
    list: api.notes.list.handler(({ input, context }) => listNotes(db, context.actor, input)),
    create: api.notes.create.handler(({ input, context }) =>
      createNote(db, storage(), context.actor, input),
    ),
    update: api.notes.update.handler(({ input, context }) =>
      updateNote(db, storage(), context.actor, input),
    ),
    delete: api.notes.delete.handler(({ input, context }) => deleteNote(db, context.actor, input)),
  },
  picking: {
    view: api.picking.view.handler(({ input, context }) => getPickView(db, context.actor, input)),
    complete: api.picking.complete.handler(({ input, context }) =>
      completePick(db, context.actor, input),
    ),
    pickLine: api.picking.pickLine.handler(({ input, context }) =>
      pickLine(db, context.actor, input),
    ),
    unpickLine: api.picking.unpickLine.handler(({ input, context }) =>
      unpickLine(db, context.actor, input),
    ),
    scan: api.picking.scan.handler(({ input, context }) => scan(db, context.actor, input)),
    linkBarcode: api.picking.linkBarcode.handler(({ input, context }) =>
      linkBarcode(db, context.actor, input),
    ),
    markOutOfStock: api.picking.markOutOfStock.handler(({ input, context }) =>
      markOutOfStock(db, context.actor, input),
    ),
    substitute: api.picking.substitute.handler(({ input, context }) =>
      substitute(db, context.actor, input),
    ),
    myPicks: api.picking.myPicks.handler(({ context }) => myPicks(db, context.actor)),
  },
  packing: {
    view: api.packing.view.handler(({ input, context }) => getPackView(db, context.actor, input)),
    complete: api.packing.complete.handler(({ input, context }) =>
      completePack(db, context.actor, input),
    ),
    addPackage: api.packing.addPackage.handler(({ input, context }) =>
      addPackage(db, context.actor, input),
    ),
    setBox: api.packing.setBox.handler(({ input, context }) =>
      setPackageBox(db, context.actor, input),
    ),
    deletePackage: api.packing.deletePackage.handler(({ input, context }) =>
      deletePackage(db, context.actor, input),
    ),
    setWeight: api.packing.setWeight.handler(({ input, context }) =>
      setWeight(db, context.actor, input),
    ),
    packUnits: api.packing.packUnits.handler(({ input, context }) =>
      packUnits(db, context.actor, input),
    ),
    unpackUnits: api.packing.unpackUnits.handler(({ input, context }) =>
      unpackUnits(db, context.actor, input),
    ),
    packRemaining: api.packing.packRemaining.handler(({ input, context }) =>
      packRemaining(db, context.actor, input),
    ),
    scan: api.packing.scan.handler(({ input, context }) =>
      scanIntoPackage(db, context.actor, input),
    ),
  },
  pickBatches: {
    create: api.pickBatches.create.handler(({ input, context }) =>
      createBatch(db, context.actor, input),
    ),
    get: api.pickBatches.get.handler(({ input, context }) => getBatch(db, context.actor, input)),
    scan: api.pickBatches.scan.handler(({ input, context }) => scanBatch(db, context.actor, input)),
    complete: api.pickBatches.complete.handler(({ input, context }) =>
      completeBatchMembers(db, context.actor, input, {
        onError: (orderId, err) => log.error({ err, orderId }, "batch complete: order failed"),
      }),
    ),
    removeOrder: api.pickBatches.removeOrder.handler(({ input, context }) =>
      removeFromBatch(db, context.actor, input),
    ),
    finish: api.pickBatches.finish.handler(({ input, context }) =>
      finishBatch(db, context.actor, input),
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
  users: {
    list: api.users.list.handler(({ input, context }) => listUsers(db, context.actor, input)),
    updateRoles: api.users.updateRoles.handler(({ input, context }) =>
      updateUserRoles(db, context.actor, input),
    ),
    deactivate: api.users.deactivate.handler(({ input, context }) =>
      deactivateUser(db, context.actor, input),
    ),
    reactivate: api.users.reactivate.handler(({ input, context }) =>
      reactivateUser(db, context.actor, input),
    ),
    setPin: api.users.setPin.handler(({ input, context }) => setPin(db, context.actor, input)),
    clearPin: api.users.clearPin.handler(({ input, context }) =>
      clearPin(db, context.actor, input),
    ),
    issueBadge: api.users.issueBadge.handler(async ({ input, context }) => {
      const badge = await issueBadge(db, context.actor, input);
      return { ...badge, qrSvg: await badgeQrSvg(badge.code) };
    }),
    revokeBadge: api.users.revokeBadge.handler(({ input, context }) =>
      revokeBadge(db, context.actor, input),
    ),
  },
  invitations: {
    list: api.invitations.list.handler(({ context }) => listInvitations(db, context.actor)),
    create: api.invitations.create.handler(({ input, context }) =>
      createInvitation(db, context.actor, input, { appUrl: env().BETTER_AUTH_URL }),
    ),
    resend: api.invitations.resend.handler(({ input, context }) =>
      resendInvitation(db, context.actor, input, { appUrl: env().BETTER_AUTH_URL }),
    ),
    revoke: api.invitations.revoke.handler(({ input, context }) =>
      revokeInvitation(db, context.actor, input),
    ),
  },
  stations: {
    list: api.stations.list.handler(({ context }) => listStations(db, context.actor)),
    // The device becomes the station: it gets the station cookie, and the admin's own session on
    // it ends. The token goes only into the cookie, never the body.
    register: api.stations.register.handler(async ({ input, context }) => {
      const { station, token } = await registerStation(db, context.actor, input);
      context.resHeaders?.append("Set-Cookie", stationCookie(token));
      await endPersonalSession(context);
      return station;
    }),
    rename: api.stations.rename.handler(({ input, context }) =>
      renameStation(db, context.actor, input),
    ),
    revoke: api.stations.revoke.handler(({ input, context }) =>
      revokeStation(db, context.actor, input),
    ),
  },
  voids: {
    void: api.voids.void.handler(({ input, context }) => voidItem(db, context.actor, input)),
    undo: api.voids.undo.handler(({ input, context }) => undoVoid(db, context.actor, input)),
    resolve: api.voids.resolve.handler(({ input, context }) =>
      resolveVoids(db, context.actor, input),
    ),
    list: api.voids.list.handler(({ input, context }) => listVoids(db, context.actor, input)),
    counts: api.voids.counts.handler(({ context }) => voidCounts(db, context.actor)),
  },
  issues: {
    report: api.issues.report.handler(({ input, context }) =>
      reportIssue(db, context.actor, input),
    ),
    update: api.issues.update.handler(({ input, context }) =>
      updateIssue(db, context.actor, input),
    ),
    setResponsible: api.issues.setResponsible.handler(({ input, context }) =>
      setResponsible(db, context.actor, input),
    ),
    resolve: api.issues.resolve.handler(({ input, context }) =>
      resolveIssue(db, context.actor, input),
    ),
    reopen: api.issues.reopen.handler(({ input, context }) =>
      reopenIssue(db, context.actor, input),
    ),
    delete: api.issues.delete.handler(({ input, context }) =>
      deleteIssue(db, context.actor, input),
    ),
    list: api.issues.list.handler(({ input, context }) => listIssues(db, context.actor, input)),
    assignees: api.issues.assignees.handler(({ context }) => issueAssignees(db, context.actor)),
    counts: api.issues.counts.handler(({ context }) => issueCounts(db, context.actor)),
    get: api.issues.get.handler(({ input, context }) => getIssue(db, context.actor, input.issueId)),
  },
  station: {
    status: stationApi.station.status.handler(({ context }) => stationStatus(db, context.station)),
    // A personal session would win over the station (actor.ts), so the worker who just unlocked
    // would act as whoever left it signed in. Unlocking ends it.
    unlockPin: stationApi.station.unlockPin.handler(async ({ input, context }) => {
      const unlocked = await unlockWithPin(db, context.station, input);
      await endPersonalSession(context);
      return unlocked;
    }),
    unlockBadge: stationApi.station.unlockBadge.handler(async ({ input, context }) => {
      const unlocked = await unlockWithBadge(db, context.station, input);
      await endPersonalSession(context);
      return unlocked;
    }),
    lock: api.station.lock.handler(async ({ context }) => {
      await lockStation(db, context.actor);
      return { ok: true as const };
    }),
    touch: api.station.touch.handler(({ context }) => touchStation(db, context.actor)),
  },
  carriers: {
    providers: api.carriers.providers.handler(({ context }) => listProviders(db, context.actor)),
    setCredentials: api.carriers.setCredentials.handler(({ input, context }) =>
      setProviderCredentials(db, context.actor, input),
    ),
    clearCredentials: api.carriers.clearCredentials.handler(({ input, context }) =>
      clearProviderCredentials(db, context.actor, input),
    ),
    updateConfig: api.carriers.updateConfig.handler(({ input, context }) =>
      updateProviderConfig(db, context.actor, input),
    ),
    test: api.carriers.test.handler(({ input, context }) => testProvider(db, context.actor, input)),
    setProviderEnabled: api.carriers.setProviderEnabled.handler(({ input, context }) =>
      setProviderEnabled(db, context.actor, input),
    ),
    config: api.carriers.config.handler(({ context }) => listShippingConfig(db, context.actor)),
    sync: api.carriers.sync.handler(({ input, context }) => syncCarriers(db, context.actor, input)),
    setCarrierEnabled: api.carriers.setCarrierEnabled.handler(({ input, context }) =>
      setCarrierEnabled(db, context.actor, input),
    ),
    setCarrierLabel: api.carriers.setCarrierLabel.handler(({ input, context }) =>
      setCarrierLabel(db, context.actor, input),
    ),
    setServiceEnabled: api.carriers.setServiceEnabled.handler(({ input, context }) =>
      setServiceEnabled(db, context.actor, input),
    ),
    orderShipping: api.carriers.orderShipping.handler(({ input, context }) =>
      getOrderShipping(db, context.actor, input),
    ),
    refreshRates: api.carriers.refreshRates.handler(({ input, context }) =>
      refreshRates(db, context.actor, input),
    ),
    recheckAddress: api.carriers.recheckAddress.handler(({ input, context }) =>
      recheckAddress(db, context.actor, input),
    ),
    keepOriginalAddress: api.carriers.keepOriginalAddress.handler(({ input, context }) =>
      keepOriginalAddress(db, context.actor, input),
    ),
  },
});

export type Router = typeof router;
