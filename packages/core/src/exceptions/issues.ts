import {
  ISSUE_DESCRIPTION_MAX,
  ISSUE_NOTES_MAX,
  type QualityIssueView,
  type ReopenIssueInput,
  type ReportIssueInput,
  type ResolveIssueInput,
  type SetResponsibleInput,
  type UpdateIssueInput,
} from "@woolrus/contracts";
import type { Db, DbTx, FulfillmentStage, Prisma, WorkflowStatus } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { lockOrder } from "../workflow/lock";
import { notifyOrderChanged } from "../workflow/notify";
import { displayName, nameFields } from "../workflow/people";
import { stageFor } from "./stage";

// Quality issues (SPEC-exceptions "Quality issue rules"). Like a void, reporting is a note about the
// order, not stage work: no claim is needed and Order.version is not bumped. Photos and voice memos
// are notes on the issue (`notes`), added after the report.

export type IssueOptions = { now?: Date };

export const issueInclude = {
  orderItem: { select: { name: true } },
  package: { select: { number: true } },
  reporter: { select: nameFields },
  responsibleUser: { select: { id: true, ...nameFields } },
  _count: { select: { notes: true } },
} as const satisfies Prisma.QualityIssueInclude;

type IssueRow = Prisma.QualityIssueGetPayload<{ include: typeof issueInclude }>;

export function toIssueView(row: IssueRow): QualityIssueView {
  return {
    id: row.id,
    orderId: row.orderId,
    orderItemId: row.orderItemId,
    lineName: row.orderItem?.name ?? null,
    packageId: row.packageId,
    packageNumber: row.package?.number ?? null,
    type: row.type,
    severity: row.severity,
    status: row.status,
    description: row.description,
    discoveredStage: row.discoveredStage,
    originStage: row.originStage,
    customerReported: row.customerReported,
    reporterId: row.reporterId,
    reporter: row.reporter ? { name: displayName(row.reporter) } : null,
    responsible: row.responsibleUser
      ? { id: row.responsibleUser.id, name: displayName(row.responsibleUser) }
      : null,
    responsibleManual: row.responsibleManual,
    resolutionNotes: row.resolutionNotes,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    noteCount: row._count.notes,
  };
}

/** The workflow move that ended each origin stage; whoever made it is who did the stage's work. */
const completedInto: Partial<Record<FulfillmentStage, WorkflowStatus>> = {
  PICKING: "PACKING",
  PACKING: "QA",
  QA: "READY",
};

/**
 * Who is responsible for a problem that started in `originStage` (FR-QI-03), from records that
 * already exist. A system actor or a deactivated user is skipped, so the answer is a person who
 * can still be asked, or nobody.
 */
export async function inferResponsible(
  tx: DbTx,
  {
    orderId,
    orderItemId,
    originStage,
  }: {
    orderId: string;
    orderItemId?: string | null;
    originStage?: FulfillmentStage | null;
  },
): Promise<string | null> {
  if (!originStage) return null;
  const candidates: (string | null)[] = [];
  if (originStage === "PICKING" && orderItemId) {
    const line = await tx.orderItem.findUnique({
      where: { id: orderItemId },
      select: { pickedById: true },
    });
    candidates.push(line?.pickedById ?? null);
  }
  const toStatus = completedInto[originStage];
  if (toStatus) {
    const event = await tx.orderStageEvent.findFirst({
      where: { orderId, toStatus },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      select: { actorId: true },
    });
    candidates.push(event?.actorId ?? null);
  }
  for (const id of candidates) {
    if (!id) continue;
    const user = await tx.user.findUnique({ where: { id }, select: { active: true } });
    if (user?.active) return id;
  }
  return null;
}

const invalid = (field: string, key: "errors.field.required" | "errors.field.tooBig") =>
  new AppError("BAD_REQUEST", "errors.validation", { [field]: key });

/** Reports a quality issue on an order, a line or a package (FR-QI-01, 02, 04). */
export async function reportIssue(
  db: Db,
  actor: Actor,
  input: ReportIssueInput,
  { now = new Date() }: IssueOptions = {},
): Promise<QualityIssueView> {
  assertCan(actor, "issue.report");
  const description = input.description.trim();
  if (!description) throw invalid("description", "errors.field.required");
  if (description.length > ISSUE_DESCRIPTION_MAX) {
    throw invalid("description", "errors.field.tooBig");
  }
  const { orderId, orderItemId, packageId, originStage, customerReported = false } = input;

  return db.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status === "CANCELLED") throw new AppError("CONFLICT", "errors.issues.orderClosed");
    if (customerReported) {
      if (order.status !== "READY" && order.status !== "COMPLETED") {
        throw new AppError("CONFLICT", "errors.issues.customerStage");
      }
    } else if (order.status === "COMPLETED") {
      throw new AppError("CONFLICT", "errors.issues.orderClosed");
    }
    // Read after the lock, so a line can't leave the order between the check and the insert.
    if (orderItemId && !(await tx.orderItem.findFirst({ where: { id: orderItemId, orderId } }))) {
      throw notFound();
    }
    if (packageId && !(await tx.package.findFirst({ where: { id: packageId, orderId } }))) {
      throw notFound();
    }

    const responsibleUserId = await inferResponsible(tx, { orderId, orderItemId, originStage });
    const created = await tx.qualityIssue.create({
      data: {
        orderId,
        orderItemId,
        packageId,
        type: input.type,
        severity: input.severity,
        description,
        discoveredStage: customerReported ? "CUSTOMER" : stageFor(order),
        originStage,
        customerReported,
        reporterId: actor.userId,
        responsibleUserId,
        createdAt: now,
      },
      include: issueInclude,
    });
    await recordAudit(tx, actor, {
      entityType: "QualityIssue",
      entityId: created.id,
      action: "issue.report",
      after: {
        orderId,
        orderItemId: orderItemId ?? null,
        packageId: packageId ?? null,
        type: created.type,
        severity: created.severity,
        discoveredStage: created.discoveredStage,
        originStage: created.originStage,
        customerReported,
        responsibleUserId,
      },
      at: now,
    });
    await notifyOrderChanged(tx, { id: order.id, status: order.status });
    return toIssueView(created);
  });
}

/**
 * The issue under its order's lock, for the edit functions. The row is read again after the lock,
 * so a racing resolve or edit has finished by now.
 */
async function lockedIssue(tx: DbTx, issueId: string) {
  const ref = await tx.qualityIssue.findUnique({
    where: { id: issueId },
    select: { orderId: true },
  });
  if (!ref) throw notFound();
  const order = await lockOrder(tx, ref.orderId);
  const issue = await tx.qualityIssue.findUnique({ where: { id: issueId } });
  if (!issue) throw notFound();
  return { order, issue };
}

/** The reporter edits their own issue; an Admin (`issue.resolve`) edits any. */
function assertReporterOrAdmin(actor: Actor, issue: { reporterId: string | null }) {
  if (issue.reporterId === actor.userId && actor.userId) return;
  assertCan(actor, "issue.resolve");
}

const view = (tx: DbTx, id: string) =>
  tx.qualityIssue.findUniqueOrThrow({ where: { id }, include: issueInclude }).then(toIssueView);

/** Edits an open issue (FR-QI-05). The inferred responsible user follows the origin and the line. */
export async function updateIssue(
  db: Db,
  actor: Actor,
  { issueId, ...changes }: UpdateIssueInput,
  { now = new Date() }: IssueOptions = {},
): Promise<QualityIssueView> {
  assertCan(actor, "issue.report");
  const description = changes.description?.trim();
  if (changes.description !== undefined) {
    if (!description) throw invalid("description", "errors.field.required");
    if (description.length > ISSUE_DESCRIPTION_MAX) {
      throw invalid("description", "errors.field.tooBig");
    }
  }
  return db.$transaction(async (tx) => {
    const { order, issue } = await lockedIssue(tx, issueId);
    assertReporterOrAdmin(actor, issue);
    if (issue.status !== "OPEN") throw new AppError("CONFLICT", "errors.issues.notOpen");
    const { orderItemId, packageId } = changes;
    if (
      orderItemId &&
      !(await tx.orderItem.findFirst({ where: { id: orderItemId, orderId: order.id } }))
    ) {
      throw notFound();
    }
    if (
      packageId &&
      !(await tx.package.findFirst({ where: { id: packageId, orderId: order.id } }))
    ) {
      throw notFound();
    }

    const next = {
      type: changes.type ?? issue.type,
      severity: changes.severity ?? issue.severity,
      description: description ?? issue.description,
      originStage: changes.originStage === undefined ? issue.originStage : changes.originStage,
      orderItemId: orderItemId === undefined ? issue.orderItemId : orderItemId,
      packageId: packageId === undefined ? issue.packageId : packageId,
    };
    const reinfer =
      !issue.responsibleManual &&
      (next.originStage !== issue.originStage || next.orderItemId !== issue.orderItemId);
    const responsibleUserId = reinfer
      ? await inferResponsible(tx, { orderId: order.id, ...next })
      : issue.responsibleUserId;
    await tx.qualityIssue.update({ where: { id: issueId }, data: { ...next, responsibleUserId } });
    const pick = (row: typeof next & { responsibleUserId: string | null }) => ({
      type: row.type,
      severity: row.severity,
      description: row.description,
      originStage: row.originStage,
      orderItemId: row.orderItemId,
      packageId: row.packageId,
      responsibleUserId: row.responsibleUserId,
    });
    await recordAudit(tx, actor, {
      entityType: "QualityIssue",
      entityId: issueId,
      action: "issue.update",
      before: pick(issue),
      after: pick({ ...next, responsibleUserId }),
      at: now,
    });
    await notifyOrderChanged(tx, { id: order.id, status: order.status });
    return view(tx, issueId);
  });
}

/** Names who is responsible (FR-QI-03), or nobody. The choice is kept when the origin changes. */
export async function setResponsible(
  db: Db,
  actor: Actor,
  { issueId, userId }: SetResponsibleInput,
  { now = new Date() }: IssueOptions = {},
): Promise<QualityIssueView> {
  assertCan(actor, "issue.report");
  return db.$transaction(async (tx) => {
    const { order, issue } = await lockedIssue(tx, issueId);
    assertReporterOrAdmin(actor, issue);
    if (issue.status !== "OPEN") throw new AppError("CONFLICT", "errors.issues.notOpen");
    if (userId) {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { active: true } });
      if (!user?.active)
        throw new AppError("BAD_REQUEST", "errors.validation", { userId: "errors.field.invalid" });
    }
    await tx.qualityIssue.update({
      where: { id: issueId },
      data: { responsibleUserId: userId, responsibleManual: true },
    });
    await recordAudit(tx, actor, {
      entityType: "QualityIssue",
      entityId: issueId,
      action: "issue.setResponsible",
      before: {
        responsibleUserId: issue.responsibleUserId,
        responsibleManual: issue.responsibleManual,
      },
      after: { responsibleUserId: userId, responsibleManual: true },
      at: now,
    });
    await notifyOrderChanged(tx, { id: order.id, status: order.status });
    return view(tx, issueId);
  });
}

/** Resolves or dismisses an open issue with a note (FR-QI-05). Admin only. */
export async function resolveIssue(
  db: Db,
  actor: Actor,
  { issueId, outcome, notes }: ResolveIssueInput,
  { now = new Date() }: IssueOptions = {},
): Promise<QualityIssueView> {
  assertCan(actor, "issue.resolve");
  const text = notes.trim();
  if (!text) throw invalid("notes", "errors.field.required");
  if (text.length > ISSUE_NOTES_MAX) throw invalid("notes", "errors.field.tooBig");
  return db.$transaction(async (tx) => {
    const { order, issue } = await lockedIssue(tx, issueId);
    if (issue.status !== "OPEN") throw new AppError("CONFLICT", "errors.issues.notOpen");
    await tx.qualityIssue.update({
      where: { id: issueId },
      data: { status: outcome, resolutionNotes: text, resolvedById: actor.userId, resolvedAt: now },
    });
    await recordAudit(tx, actor, {
      entityType: "QualityIssue",
      entityId: issueId,
      action: "issue.resolve",
      before: { status: issue.status },
      after: { status: outcome, resolutionNotes: text, resolvedAt: now.toISOString() },
      at: now,
    });
    await notifyOrderChanged(tx, { id: order.id, status: order.status });
    return view(tx, issueId);
  });
}

/**
 * Puts a resolved or dismissed issue back to open. The old resolution is copied into an internal
 * note on the issue first, so nothing is lost.
 */
export async function reopenIssue(
  db: Db,
  actor: Actor,
  { issueId }: ReopenIssueInput,
  { now = new Date() }: IssueOptions = {},
): Promise<QualityIssueView> {
  assertCan(actor, "issue.resolve");
  return db.$transaction(async (tx) => {
    const { order, issue } = await lockedIssue(tx, issueId);
    if (issue.status === "OPEN") throw new AppError("CONFLICT", "errors.issues.alreadyOpen");
    if (issue.resolutionNotes) {
      await tx.note.create({
        data: {
          orderId: order.id,
          qualityIssueId: issueId,
          authorId: actor.userId,
          visibility: "INTERNAL",
          content: `${issue.status === "DISMISSED" ? "Dismissed" : "Resolved"}: ${issue.resolutionNotes}`,
        },
      });
    }
    await tx.qualityIssue.update({
      where: { id: issueId },
      data: { status: "OPEN", resolutionNotes: null, resolvedById: null, resolvedAt: null },
    });
    await recordAudit(tx, actor, {
      entityType: "QualityIssue",
      entityId: issueId,
      action: "issue.reopen",
      before: { status: issue.status, resolutionNotes: issue.resolutionNotes },
      after: { status: "OPEN" },
      at: now,
    });
    await notifyOrderChanged(tx, { id: order.id, status: order.status });
    return view(tx, issueId);
  });
}
