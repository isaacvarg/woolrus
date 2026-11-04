import {
  addPackage,
  archiveBox,
  archiveLabAddress,
  archiveLabGroup,
  archiveLabParcel,
  cancelLabRun,
  clearPin,
  clearProviderCredentials,
  clearSecret,
  completeBatchMembers,
  completePack,
  completePick,
  completeQaOrder,
  createBatch,
  createBox,
  createInvitation,
  createLabAddress,
  createLabelPrint,
  createLabGroup,
  createLabParcel,
  createManifest,
  createNote,
  createPriorityRule,
  createShippingProviders,
  customsProducts,
  deactivateUser,
  deleteBox,
  deleteIssue,
  deleteNote,
  deletePackage,
  deletePriorityRule,
  dismissFailedJob,
  duplicateLabAddress,
  duplicateLabParcel,
  finishBatch,
  getBatch,
  getEmailSender,
  getIssue,
  getLabRun,
  getOrder,
  getOrderHistory,
  getOrderShipping,
  getPackView,
  getPickView,
  getPublicSettings,
  getQaScreen,
  getSettings,
  getSyncStatus,
  issueAssignees,
  issueBadge,
  issueCounts,
  keepOriginalAddress,
  labRunTrends,
  labTrendGrid,
  labTrendSeries,
  labTrendsReport,
  linkBarcode,
  listBoxes,
  listFailedJobs,
  listInvitations,
  listIssues,
  listLabAddresses,
  listLabGroups,
  listLabParcelProducts,
  listLabParcels,
  listLabRuns,
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
  manifestCandidates,
  markLabelNotBought,
  markOutOfStock,
  myPicks,
  orderCustoms,
  orderMutations,
  orderPrintableLabels,
  packRemaining,
  packUnits,
  permissionsFor,
  pickLine,
  previewLabRun,
  pushErrors,
  queueCounts,
  quoteOneOff,
  reactivateUser,
  realOrders,
  recheckAddress,
  recheckLabAddress,
  refreshRates,
  registerStation,
  removeFromBatch,
  renameLabGroup,
  renameStation,
  reopenIssue,
  reorderPriorityRules,
  repackOrders,
  reportIssue,
  requestSync,
  resendInvitation,
  resolveIssue,
  resolveVoids,
  restoreBox,
  retryFailedJob,
  retryVoid,
  retryWooPush,
  revokeBadge,
  revokeInvitation,
  revokeStation,
  saveOneOffAddress,
  saveOneOffParcel,
  scan,
  scanBatch,
  scanIntoPackage,
  scanVerify,
  selectRate,
  sendTestEmail,
  setCarrierEnabled,
  setCarrierLabel,
  setPackageBox,
  setPin,
  setProviderCredentials,
  setProviderEnabled,
  setRateSelectionReason,
  setResponsible,
  setSecret,
  setServiceEnabled,
  setVerified,
  setWeight,
  shipOrders,
  startLabRun,
  stationStatus,
  stuckLabels,
  substitute,
  syncCarriers,
  testProvider,
  testStoreConnection,
  touchStation,
  unarchiveLabAddress,
  unarchiveLabParcel,
  undoVoid,
  unlockWithBadge,
  unlockWithPin,
  unpackUnits,
  unpickLine,
  updateBox,
  updateIssue,
  updateLabAddress,
  updateLabParcel,
  updateNote,
  updatePreferences,
  updatePriorityRule,
  updateProductCustoms,
  updateProviderConfig,
  updateSettings,
  updateUserRoles,
  voidCounts,
  voidItem,
  voidLabel,
  writeOffLabel,
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
  shipping: {
    shipOrders: api.shipping.shipOrders.handler(({ input, context }) =>
      shipOrders(db, context.actor, input),
    ),
    createLabelPrint: api.shipping.createLabelPrint.handler(({ input, context }) =>
      createLabelPrint(db, context.actor, input),
    ),
    orderPrintableLabels: api.shipping.orderPrintableLabels.handler(({ input, context }) =>
      orderPrintableLabels(db, context.actor, input),
    ),
    orderCustoms: api.shipping.orderCustoms.handler(({ input, context }) =>
      orderCustoms(db, context.actor, input),
    ),
    repack: api.shipping.repack.handler(async ({ input, context }) =>
      repackOrders(db, context.actor, input, { providers: await createShippingProviders(db) }),
    ),
    retryVoid: api.shipping.retryVoid.handler(async ({ input, context }) =>
      retryVoid(db, context.actor, input, { providers: await createShippingProviders(db) }),
    ),
    writeOffLabel: api.shipping.writeOffLabel.handler(({ input, context }) =>
      writeOffLabel(db, context.actor, input),
    ),
    stuckLabels: api.shipping.stuckLabels.handler(({ input, context }) =>
      stuckLabels(db, context.actor, input),
    ),
    pushErrors: api.shipping.pushErrors.handler(({ context }) => pushErrors(db, context.actor)),
    retryWooPush: api.shipping.retryWooPush.handler(({ input, context }) =>
      retryWooPush(db, context.actor, input),
    ),
    customsProducts: api.shipping.customsProducts.handler(({ input, context }) =>
      customsProducts(db, context.actor, input),
    ),
    updateProductCustoms: api.shipping.updateProductCustoms.handler(({ input, context }) =>
      updateProductCustoms(db, context.actor, input),
    ),
    manifestCandidates: api.shipping.manifestCandidates.handler(async ({ input, context }) =>
      manifestCandidates(db, context.actor, await createShippingProviders(db), input),
    ),
    createManifest: api.shipping.createManifest.handler(async ({ input, context }) =>
      createManifest(db, context.actor, await createShippingProviders(db), storage(), input),
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
      completeQaOrder(db, context.actor, input),
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
  qa: {
    screen: api.qa.screen.handler(({ input, context }) => getQaScreen(db, context.actor, input)),
    setVerified: api.qa.setVerified.handler(({ input, context }) =>
      setVerified(db, context.actor, input),
    ),
    selectRate: api.qa.selectRate.handler(({ input, context }) =>
      selectRate(db, context.actor, input),
    ),
    setRateSelectionReason: api.qa.setRateSelectionReason.handler(({ input, context }) =>
      setRateSelectionReason(db, context.actor, input),
    ),
    scan: api.qa.scan.handler(({ input, context }) => scanVerify(db, context.actor, input)),
    voidLabel: api.qa.voidLabel.handler(({ input, context }) =>
      voidLabel(db, context.actor, input),
    ),
    markLabelNotBought: api.qa.markLabelNotBought.handler(({ input, context }) =>
      markLabelNotBought(db, context.actor, input),
    ),
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
  operations: {
    jobs: {
      failed: {
        list: api.operations.jobs.failed.list.handler(({ input, context }) =>
          listFailedJobs(db, context.actor, input),
        ),
        retry: api.operations.jobs.failed.retry.handler(({ input, context }) =>
          retryFailedJob(db, context.actor, input),
        ),
        dismiss: api.operations.jobs.failed.dismiss.handler(({ input, context }) =>
          dismissFailedJob(db, context.actor, input),
        ),
      },
    },
  },
  rateLab: {
    addresses: api.rateLab.addresses.handler(({ input, context }) =>
      listLabAddresses(db, context.actor, input),
    ),
    createAddress: api.rateLab.createAddress.handler(async ({ input, context }) =>
      createLabAddress(db, context.actor, input, { providers: await createShippingProviders(db) }),
    ),
    updateAddress: api.rateLab.updateAddress.handler(async ({ input, context }) =>
      updateLabAddress(db, context.actor, input, { providers: await createShippingProviders(db) }),
    ),
    recheckAddress: api.rateLab.recheckAddress.handler(async ({ input, context }) =>
      recheckLabAddress(db, context.actor, input, { providers: await createShippingProviders(db) }),
    ),
    duplicateAddress: api.rateLab.duplicateAddress.handler(({ input, context }) =>
      duplicateLabAddress(db, context.actor, input),
    ),
    archiveAddress: api.rateLab.archiveAddress.handler(({ input, context }) =>
      archiveLabAddress(db, context.actor, input),
    ),
    unarchiveAddress: api.rateLab.unarchiveAddress.handler(({ input, context }) =>
      unarchiveLabAddress(db, context.actor, input),
    ),
    parcels: api.rateLab.parcels.handler(({ input, context }) =>
      listLabParcels(db, context.actor, input),
    ),
    createParcel: api.rateLab.createParcel.handler(({ input, context }) =>
      createLabParcel(db, context.actor, input),
    ),
    updateParcel: api.rateLab.updateParcel.handler(({ input, context }) =>
      updateLabParcel(db, context.actor, input),
    ),
    duplicateParcel: api.rateLab.duplicateParcel.handler(({ input, context }) =>
      duplicateLabParcel(db, context.actor, input),
    ),
    archiveParcel: api.rateLab.archiveParcel.handler(({ input, context }) =>
      archiveLabParcel(db, context.actor, input),
    ),
    unarchiveParcel: api.rateLab.unarchiveParcel.handler(({ input, context }) =>
      unarchiveLabParcel(db, context.actor, input),
    ),
    parcelProducts: api.rateLab.parcelProducts.handler(({ input, context }) =>
      listLabParcelProducts(db, context.actor, input),
    ),
    groups: api.rateLab.groups.handler(({ input, context }) =>
      listLabGroups(db, context.actor, input),
    ),
    createGroup: api.rateLab.createGroup.handler(({ input, context }) =>
      createLabGroup(db, context.actor, input),
    ),
    renameGroup: api.rateLab.renameGroup.handler(({ input, context }) =>
      renameLabGroup(db, context.actor, input),
    ),
    archiveGroup: api.rateLab.archiveGroup.handler(({ input, context }) =>
      archiveLabGroup(db, context.actor, input),
    ),
    realOrders: api.rateLab.realOrders.handler(({ input, context }) =>
      realOrders(db, context.actor, input),
    ),
    previewRun: api.rateLab.previewRun.handler(({ input, context }) =>
      previewLabRun(db, context.actor, input),
    ),
    startRun: api.rateLab.startRun.handler(async ({ input, context }) =>
      startLabRun(db, context.actor, input, { providers: await createShippingProviders(db) }),
    ),
    runs: api.rateLab.runs.handler(({ input, context }) => listLabRuns(db, context.actor, input)),
    quoteOneOff: api.rateLab.quoteOneOff.handler(async ({ input, context }) =>
      quoteOneOff(db, context.actor, input, { providers: await createShippingProviders(db) }),
    ),
    saveOneOffAddress: api.rateLab.saveOneOffAddress.handler(async ({ input, context }) =>
      saveOneOffAddress(db, context.actor, input, {
        providers: await createShippingProviders(db),
      }),
    ),
    saveOneOffParcel: api.rateLab.saveOneOffParcel.handler(({ input, context }) =>
      saveOneOffParcel(db, context.actor, input),
    ),
    trendGrid: api.rateLab.trendGrid.handler(({ input, context }) =>
      labTrendGrid(db, context.actor, input),
    ),
    trendSeries: api.rateLab.trendSeries.handler(({ input, context }) =>
      labTrendSeries(db, context.actor, input),
    ),
    run: api.rateLab.run.handler(({ input, context }) => getLabRun(db, context.actor, input)),
    cancelRun: api.rateLab.cancelRun.handler(({ input, context }) =>
      cancelLabRun(db, context.actor, input),
    ),
    runTrends: api.rateLab.runTrends.handler(({ input, context }) =>
      labRunTrends(db, context.actor, input),
    ),
    trendsReport: api.rateLab.trendsReport.handler(({ input, context }) =>
      labTrendsReport(db, context.actor, input),
    ),
  },
});

export type Router = typeof router;
