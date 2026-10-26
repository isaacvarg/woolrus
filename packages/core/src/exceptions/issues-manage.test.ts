import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { queues } from "../jobs";
import {
  deleteIssue,
  linkIssueToRepack,
  reopenIssue,
  reportIssue,
  resolveIssue,
  setResponsible,
  updateIssue,
} from "./issues";
import { getIssue, issueAssignees, issueCounts, listIssues } from "./queries";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const base = { type: "PACKAGING_DAMAGE", severity: "MAJOR", description: "Crushed" } as const;

async function setup() {
  const qa = await createActor(db, ["QA"]);
  const admin = await createActor(db, ["ADMIN"]);
  const other = await createActor(db, ["PACKER"]);
  const { order, items } = await createOrder(db, { status: "QA" });
  const issue = await reportIssue(db, qa, { orderId: order.id, ...base });
  return { qa, admin, other, order, items, issue };
}

describe("updateIssue", () => {
  it("lets the reporter edit an open issue and audits it", async () => {
    const { qa, issue } = await setup();
    const updated = await updateIssue(db, qa, {
      issueId: issue.id,
      severity: "CRITICAL",
      description: " Torn ",
    });
    expect(updated).toMatchObject({ severity: "CRITICAL", description: "Torn" });
    expect(await db.auditEvent.count({ where: { action: "issue.update" } })).toBe(1);
  });

  it("lets an Admin edit someone else's issue; another floor user is forbidden", async () => {
    const { admin, other, issue } = await setup();
    await expect(
      updateIssue(db, other, { issueId: issue.id, type: "OTHER" }),
    ).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect((await updateIssue(db, admin, { issueId: issue.id, type: "OTHER" })).type).toBe("OTHER");
  });

  it("refuses a resolved issue", async () => {
    const { qa, admin, issue } = await setup();
    await resolveIssue(db, admin, { issueId: issue.id, outcome: "RESOLVED", notes: "ok" });
    await expect(updateIssue(db, qa, { issueId: issue.id, type: "OTHER" })).rejects.toMatchObject({
      messageKey: "errors.issues.notOpen",
    });
  });

  it("re-infers the responsible user from the origin unless a person chose", async () => {
    const { qa, admin, order, issue } = await setup();
    await db.orderStageEvent.create({
      data: { orderId: order.id, toStatus: "QA", actorId: admin.userId },
    });
    const inferred = await updateIssue(db, qa, { issueId: issue.id, originStage: "PACKING" });
    expect(inferred.responsible?.id).toBe(admin.userId);
    await setResponsible(db, qa, { issueId: issue.id, userId: qa.userId });
    const kept = await updateIssue(db, qa, { issueId: issue.id, originStage: null });
    expect(kept.responsible?.id).toBe(qa.userId);
  });

  it("refuses a line from another order", async () => {
    const { qa, issue } = await setup();
    const { items } = await createOrder(db, { status: "QA" });
    await expect(
      updateIssue(db, qa, { issueId: issue.id, orderItemId: items[0]?.id }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});

describe("setResponsible", () => {
  it("accepts an active user, marks it manual, and allows clearing", async () => {
    const { qa, other, issue } = await setup();
    const set = await setResponsible(db, qa, { issueId: issue.id, userId: other.userId });
    expect(set).toMatchObject({ responsible: { id: other.userId }, responsibleManual: true });
    expect(
      (await setResponsible(db, qa, { issueId: issue.id, userId: null })).responsible,
    ).toBeNull();
  });

  it("rejects an unknown or deactivated user and a stranger", async () => {
    const { qa, other, issue } = await setup();
    const gone = await createActor(db, ["PICKER"]);
    await db.user.update({ where: { id: gone.userId }, data: { active: false } });
    await expect(
      setResponsible(db, qa, { issueId: issue.id, userId: gone.userId }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
    await expect(
      setResponsible(db, qa, { issueId: issue.id, userId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
    await expect(
      setResponsible(db, other, { issueId: issue.id, userId: other.userId }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("resolveIssue / reopenIssue", () => {
  it("resolves and dismisses with a note; reopen keeps the old resolution as a note", async () => {
    const { admin, issue } = await setup();
    const resolved = await resolveIssue(db, admin, {
      issueId: issue.id,
      outcome: "DISMISSED",
      notes: " Not an issue ",
    });
    expect(resolved).toMatchObject({ status: "DISMISSED", resolutionNotes: "Not an issue" });
    const row = await db.qualityIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row).toMatchObject({ resolvedById: admin.userId });

    const reopened = await reopenIssue(db, admin, { issueId: issue.id });
    expect(reopened).toMatchObject({ status: "OPEN", resolutionNotes: null, resolvedAt: null });
    const notes = await db.note.findMany({ where: { qualityIssueId: issue.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ visibility: "INTERNAL" });
    expect(notes[0]?.content).toContain("Not an issue");
    expect(
      await db.auditEvent.count({ where: { action: { in: ["issue.resolve", "issue.reopen"] } } }),
    ).toBe(2);
  });

  it("is Admin only, needs a note, and only acts on the right status", async () => {
    const { qa, admin, issue } = await setup();
    const input = { issueId: issue.id, outcome: "RESOLVED", notes: "done" } as const;
    await expect(resolveIssue(db, qa, input)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(resolveIssue(db, admin, { ...input, notes: "  " })).rejects.toMatchObject({
      kind: "BAD_REQUEST",
    });
    await expect(reopenIssue(db, admin, { issueId: issue.id })).rejects.toMatchObject({
      messageKey: "errors.issues.alreadyOpen",
    });
    await resolveIssue(db, admin, input);
    await expect(resolveIssue(db, admin, input)).rejects.toMatchObject({
      messageKey: "errors.issues.notOpen",
    });
    await expect(reopenIssue(db, qa, { issueId: issue.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});

describe("issue reads", () => {
  it("filters All / Open / Resolved, by severity and type, with open Critical first", async () => {
    const { qa, admin, order } = await setup();
    const minor = await reportIssue(db, qa, {
      orderId: order.id,
      ...base,
      severity: "MINOR",
      type: "OTHER",
    });
    const critical = await reportIssue(db, qa, {
      orderId: order.id,
      ...base,
      severity: "CRITICAL",
    });
    await resolveIssue(db, admin, { issueId: minor.id, outcome: "DISMISSED", notes: "x" });

    const all = await listIssues(db, qa, {});
    expect(all.rows).toHaveLength(3);
    expect(all.rows[0]?.id).toBe(critical.id);
    expect((await listIssues(db, qa, { status: "open" })).rows).toHaveLength(2);
    expect((await listIssues(db, qa, { status: "resolved" })).rows.map((r) => r.id)).toEqual([
      minor.id,
    ]);
    expect((await listIssues(db, qa, { severity: "CRITICAL" })).rows).toHaveLength(1);
    expect((await listIssues(db, qa, { type: "OTHER" })).rows).toHaveLength(1);
    expect((await listIssues(db, qa, { search: order.number })).rows).toHaveLength(3);
    expect((await listIssues(db, qa, { search: "zzzz" })).rows).toHaveLength(0);
  });

  it("pages without skipping or repeating", async () => {
    const { qa, order } = await setup();
    await reportIssue(db, qa, { orderId: order.id, ...base, severity: "CRITICAL" });
    await reportIssue(db, qa, { orderId: order.id, ...base });
    const first = await listIssues(db, qa, { limit: 2 });
    const second = await listIssues(db, qa, { limit: 2, cursor: first.nextCursor ?? undefined });
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
    expect(second.nextCursor).toBeNull();
  });

  it("gets one, counts open and critical, and needs order.read", async () => {
    const { qa, order, issue } = await setup();
    await reportIssue(db, qa, { orderId: order.id, ...base, severity: "CRITICAL" });
    expect(await getIssue(db, qa, issue.id)).toMatchObject({
      id: issue.id,
      orderNumber: order.number,
    });
    expect(await issueCounts(db, qa)).toEqual({ open: 2, openCritical: 1 });
    await expect(getIssue(db, qa, crypto.randomUUID())).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    await expect(
      issueCounts(db, { userId: null, roles: [], stationId: null } as never),
    ).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});

describe("issueAssignees", () => {
  it("lists active users only", async () => {
    const { qa } = await setup();
    const gone = await createActor(db, ["PICKER"]);
    await db.user.update({ where: { id: gone.userId }, data: { active: false } });
    const ids = (await issueAssignees(db, qa)).map((u) => u.id);
    expect(ids).toContain(qa.userId);
    expect(ids).not.toContain(gone.userId);
  });
});

describe("deleteIssue", () => {
  const deleteJobs = () =>
    db.$queryRaw<{ keys: string[] }[]>`
      SELECT data->'keys' AS keys FROM pgboss.job WHERE name = ${queues.storageDelete}`;

  beforeEach(async () => {
    await db.$executeRaw`DELETE FROM pgboss.job WHERE name = ${queues.storageDelete}`;
  });

  it("removes the issue, its notes and attachments, enqueues the file job and audits a snapshot", async () => {
    const { admin, order, issue } = await setup();
    const note = await db.note.create({
      data: {
        orderId: order.id,
        qualityIssueId: issue.id,
        content: "Photo",
        visibility: "INTERNAL",
      },
    });
    await db.noteAttachment.create({
      data: {
        noteId: note.id,
        kind: "IMAGE",
        storageKey: "notes/a.jpg",
        thumbnailKey: "notes/a.thumb.jpg",
        contentType: "image/jpeg",
        fileName: "a.jpg",
        sizeBytes: 10,
      },
    });
    await deleteIssue(db, admin, { issueId: issue.id });
    expect(await db.qualityIssue.count()).toBe(0);
    expect(await db.note.count({ where: { qualityIssueId: issue.id } })).toBe(0);
    expect(await db.noteAttachment.count()).toBe(0);
    const jobs = await deleteJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.keys.sort()).toEqual(["notes/a.jpg", "notes/a.thumb.jpg"]);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "issue.delete" } });
    expect(audit.before).toMatchObject({ orderId: order.id, type: "PACKAGING_DAMAGE" });
  });

  it("is Admin only, even for the reporter", async () => {
    const { qa, issue } = await setup();
    await expect(deleteIssue(db, qa, { issueId: issue.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect(await db.qualityIssue.count()).toBe(1);
    expect(await deleteJobs()).toEqual([]);
  });

  it("is not found for an unknown issue", async () => {
    const { admin } = await setup();
    await expect(deleteIssue(db, admin, { issueId: crypto.randomUUID() })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });
});

describe("linkIssueToRepack", () => {
  const labelOf = (packageId: string) =>
    db.shippingLabel.findFirstOrThrow({ where: { packageId } });

  it("sets the label and triggeredRepack", async () => {
    const qa = await createActor(db, ["QA"]);
    const { order, packages } = await createOrder(db, {
      status: "QA",
      packages: [{ label: "ACTIVE" }],
    });
    const issue = await reportIssue(db, qa, { orderId: order.id, ...base });
    const label = await labelOf(packages[0]?.id ?? "");
    await db.$transaction((tx) =>
      linkIssueToRepack(tx, qa, { issueId: issue.id, labelId: label.id }),
    );
    const row = await db.qualityIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row).toMatchObject({ labelId: label.id, triggeredRepack: true });
    expect(await db.auditEvent.count({ where: { action: "issue.linkRepack" } })).toBe(1);
  });

  it("refuses a label from another order", async () => {
    const { qa, issue } = await setup();
    const other = await createOrder(db, { status: "QA", packages: [{ label: "ACTIVE" }] });
    const label = await labelOf(other.packages[0]?.id ?? "");
    await expect(
      db.$transaction((tx) => linkIssueToRepack(tx, qa, { issueId: issue.id, labelId: label.id })),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    const row = await db.qualityIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row).toMatchObject({ labelId: null, triggeredRepack: false });
  });
});
