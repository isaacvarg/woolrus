import type { WorkflowStatus } from "@woolrus/db";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import {
  canTransition,
  type TransitionKind,
  transitionFor,
  transitionKinds,
  workflowStatuses,
} from "./machine";

const active = ["PENDING", "PICKING", "PACKING", "QA", "READY"] as const;

// Every non-force move the spec allows, spelled out independently of the table in machine.ts.
const listed: [WorkflowStatus, WorkflowStatus, TransitionKind][] = [
  ["PENDING", "PICKING", "beginPicking"],
  ["PICKING", "PACKING", "completePicking"],
  ["PACKING", "QA", "completePacking"],
  ["QA", "READY", "completeQa"],
  ["READY", "COMPLETED", "ship"],
  ["READY", "PACKING", "repack"],
  ...active.map((from): [WorkflowStatus, WorkflowStatus, TransitionKind] => [
    from,
    "ON_HOLD",
    "hold",
  ]),
  ...active.map((to): [WorkflowStatus, WorkflowStatus, TransitionKind] => [
    "ON_HOLD",
    to,
    "resume",
  ]),
  ...[...active, "ON_HOLD" as const].map(
    (from): [WorkflowStatus, WorkflowStatus, TransitionKind] => [from, "CANCELLED", "cancel"],
  ),
];

function isListed(from: WorkflowStatus, to: WorkflowStatus, kind: TransitionKind): boolean {
  if (kind === "forceStatus") return from !== to;
  return listed.some(([f, t, k]) => f === from && t === to && k === kind);
}

const combinations = workflowStatuses.flatMap((from) =>
  workflowStatuses.flatMap((to) => transitionKinds.map((kind) => ({ from, to, kind }))),
);

describe("workflow machine", () => {
  it("covers every status and transition kind", () => {
    expect(workflowStatuses).toHaveLength(8);
    expect(transitionKinds).toHaveLength(10);
    expect(combinations).toHaveLength(8 * 8 * 10);
  });

  it.each(combinations)("$from → $to by $kind", ({ from, to, kind }) => {
    const allowed = isListed(from, to, kind);
    expect(canTransition(from, to, kind)).toBe(allowed);
    if (allowed) {
      expect(transitionFor(from, to, kind).kind).toBe(kind);
    } else {
      expect(() => transitionFor(from, to, kind)).toThrow(
        expect.objectContaining({
          kind: "CONFLICT",
          messageKey: "errors.workflow.illegalTransition",
        }),
      );
    }
  });

  it("throws an AppError for an illegal move", () => {
    expect(() => transitionFor("PENDING", "QA", "completePacking")).toThrow(AppError);
  });

  it("leaves terminal states only by force", () => {
    for (const from of ["COMPLETED", "CANCELLED"] as const) {
      for (const to of workflowStatuses) {
        for (const kind of transitionKinds) {
          if (kind !== "forceStatus") expect(canTransition(from, to, kind)).toBe(false);
        }
        if (to !== from) expect(canTransition(from, to, "forceStatus")).toBe(true);
      }
    }
  });

  it("describes the stage completions", () => {
    expect(transitionFor("PENDING", "PICKING", "beginPicking")).toMatchObject({
      permission: "order.pick",
      claim: "claims",
      gate: null,
      reasonRequired: false,
    });
    expect(transitionFor("PICKING", "PACKING", "completePicking")).toMatchObject({
      permission: "order.pick",
      claim: "holds",
      gate: "picked",
    });
    expect(transitionFor("PACKING", "QA", "completePacking")).toMatchObject({
      permission: "order.pack",
      claim: "holds",
      gate: "packed",
    });
    expect(transitionFor("QA", "READY", "completeQa")).toMatchObject({
      permission: "order.qa",
      claim: "holds",
      gate: "verified",
    });
    expect(transitionFor("READY", "COMPLETED", "ship")).toMatchObject({
      permission: "order.ship",
      claim: "none",
      gate: "shippable",
      reasonRequired: false,
    });
  });

  it("describes the corrections", () => {
    expect(transitionFor("READY", "PACKING", "repack")).toMatchObject({
      permission: "order.pack",
      claim: "none",
      gate: "noLiveLabels",
      reasonRequired: true,
    });
    expect(transitionFor("QA", "ON_HOLD", "hold")).toMatchObject({
      permission: "order.hold",
      gate: null,
      reasonRequired: true,
    });
    expect(transitionFor("ON_HOLD", "QA", "resume")).toMatchObject({
      permission: "order.hold",
      gate: null,
      reasonRequired: false,
    });
    expect(transitionFor("PICKING", "CANCELLED", "cancel")).toMatchObject({
      permission: "order.cancel",
      gate: "noLiveLabels",
      reasonRequired: true,
    });
  });

  it("skips gates on force, except out of COMPLETED into a non-terminal status", () => {
    expect(transitionFor("PENDING", "READY", "forceStatus")).toMatchObject({
      permission: "order.forceStatus",
      claim: "none",
      gate: null,
      reasonRequired: true,
    });
    expect(transitionFor("COMPLETED", "CANCELLED", "forceStatus").gate).toBeNull();
    for (const to of [...active, "ON_HOLD" as const]) {
      expect(transitionFor("COMPLETED", to, "forceStatus").gate).toBe("noLiveLabels");
    }
    expect(transitionFor("CANCELLED", "PENDING", "forceStatus").gate).toBeNull();
  });
});
