import type { WorkflowStatus } from "@woolrus/db";
import { AppError } from "../errors";
import type { Permission } from "../permissions";

// The order workflow as data (SPEC-workflow "State machine"). Pure: who holds the claim, what the
// gates read and where a held order resumes to are the transition service's job.

export const workflowStatuses = [
  "PENDING",
  "PICKING",
  "PACKING",
  "QA",
  "READY",
  "COMPLETED",
  "ON_HOLD",
  "CANCELLED",
] as const satisfies readonly WorkflowStatus[];

const activeStatuses = [
  "PENDING",
  "PICKING",
  "PACKING",
  "QA",
  "READY",
] as const satisfies readonly WorkflowStatus[];
const terminalStatuses: readonly WorkflowStatus[] = ["COMPLETED", "CANCELLED"];

export const transitionKinds = [
  "beginPicking",
  "completePicking",
  "completePacking",
  "completeQa",
  "ship",
  "repack",
  "hold",
  "resume",
  "cancel",
  "forceStatus",
] as const;
export type TransitionKind = (typeof transitionKinds)[number];

export type GateKind = "picked" | "packed" | "verified" | "shippable" | "noLiveLabels";

export type Transition = {
  kind: TransitionKind;
  from: readonly WorkflowStatus[];
  to: readonly WorkflowStatus[];
  permission: Permission;
  /** `claims`: the actor takes the claim. `holds`: the actor must hold a live claim. */
  claim: "claims" | "holds" | "none";
  gate: GateKind | null;
  reasonRequired: boolean;
};

export const transitions: readonly Transition[] = [
  {
    kind: "beginPicking",
    from: ["PENDING"],
    to: ["PICKING"],
    permission: "order.pick",
    claim: "claims",
    gate: null,
    reasonRequired: false,
  },
  {
    kind: "completePicking",
    from: ["PICKING"],
    to: ["PACKING"],
    permission: "order.pick",
    claim: "holds",
    gate: "picked",
    reasonRequired: false,
  },
  {
    kind: "completePacking",
    from: ["PACKING"],
    to: ["QA"],
    permission: "order.pack",
    claim: "holds",
    gate: "packed",
    reasonRequired: false,
  },
  {
    kind: "completeQa",
    from: ["QA"],
    to: ["READY"],
    permission: "order.qa",
    claim: "holds",
    gate: "verified",
    reasonRequired: false,
  },
  {
    kind: "ship",
    from: ["READY"],
    to: ["COMPLETED"],
    permission: "order.ship",
    claim: "none",
    gate: "shippable",
    reasonRequired: false,
  },
  {
    kind: "repack",
    from: ["READY"],
    to: ["PACKING"],
    permission: "order.pack",
    claim: "none",
    gate: "noLiveLabels",
    reasonRequired: true,
  },
  {
    kind: "hold",
    from: activeStatuses,
    to: ["ON_HOLD"],
    permission: "order.hold",
    claim: "none",
    gate: null,
    reasonRequired: true,
  },
  {
    // The machine allows any active status; the service only accepts the order's heldFromStatus.
    kind: "resume",
    from: ["ON_HOLD"],
    to: activeStatuses,
    permission: "order.hold",
    claim: "none",
    gate: null,
    reasonRequired: false,
  },
  {
    kind: "cancel",
    from: [...activeStatuses, "ON_HOLD"],
    to: ["CANCELLED"],
    permission: "order.cancel",
    claim: "none",
    gate: "noLiveLabels",
    reasonRequired: true,
  },
  {
    kind: "forceStatus",
    from: workflowStatuses,
    to: workflowStatuses,
    permission: "order.forceStatus",
    claim: "none",
    gate: null,
    reasonRequired: true,
  },
];

export function canTransition(
  from: WorkflowStatus,
  to: WorkflowStatus,
  kind: TransitionKind,
): boolean {
  return (
    from !== to &&
    transitions.some((t) => t.kind === kind && t.from.includes(from) && t.to.includes(to))
  );
}

/**
 * The rule for one move, or `CONFLICT` / `errors.workflow.illegalTransition`. Force skips gates,
 * except that it never takes a COMPLETED order back into a non-terminal status while live labels exist.
 */
export function transitionFor(
  from: WorkflowStatus,
  to: WorkflowStatus,
  kind: TransitionKind,
): Transition {
  const rule = transitions.find((t) => t.kind === kind);
  if (!rule || !canTransition(from, to, kind)) {
    throw new AppError("CONFLICT", "errors.workflow.illegalTransition");
  }
  if (kind === "forceStatus" && from === "COMPLETED" && !terminalStatuses.includes(to)) {
    return { ...rule, gate: "noLiveLabels" };
  }
  return rule;
}
