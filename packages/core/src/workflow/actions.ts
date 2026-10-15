import type { OrderAction } from "@woolrus/contracts";
import type { WorkflowStatus } from "@woolrus/db";
import { type Actor, can } from "../permissions";
import { claimPermission, holdsClaim } from "./claims";
import { canTransition, ruleFor, type TransitionKind } from "./machine";

// What the caller may do to an order, for the detail page's buttons (SPEC-workflow "Reads"). Built
// from the machine, permissions and the claim, never from gates: a completion refused by its gate
// is still offered so the person sees what's missing. The server re-checks everything anyway.

export type ActionSubject = {
  status: WorkflowStatus;
  heldFromStatus: WorkflowStatus | null;
  /** The holder of a live claim; null when unclaimed or expired. */
  liveClaimHolderId: string | null;
};

/** The stage completions, which need the actor's live claim. */
const completions: readonly { kind: TransitionKind; to: WorkflowStatus }[] = [
  { kind: "completePicking", to: "PACKING" },
  { kind: "completePacking", to: "QA" },
  { kind: "completeQa", to: "READY" },
];

export function allowedActions(actor: Actor, order: ActionSubject): OrderAction[] {
  const { status, heldFromStatus, liveClaimHolderId } = order;
  const mine = holdsClaim(actor, liveClaimHolderId);
  const othersClaim = liveClaimHolderId !== null && !mine;
  const allowed = (kind: TransitionKind, to: WorkflowStatus) =>
    can(actor, ruleFor(kind).permission) && canTransition(status, to, kind);

  const actions: OrderAction[] = [];

  // Like the server, never over someone else's live claim: that's a takeover.
  if (allowed("beginPicking", "PICKING") && !othersClaim) actions.push("beginPicking");
  for (const { kind, to } of completions) {
    if (mine && allowed(kind, to)) actions.push(kind as OrderAction);
  }

  const claimWith = claimPermission[status];
  if (claimWith && can(actor, claimWith)) {
    if (liveClaimHolderId === null) actions.push("claim");
    if (othersClaim) actions.push("takeOver");
  }
  if (liveClaimHolderId !== null && (mine || actor.roles.includes("ADMIN"))) {
    actions.push("release");
  }

  if (allowed("hold", "ON_HOLD")) actions.push("hold");
  if (heldFromStatus && allowed("resume", heldFromStatus)) actions.push("resume");
  if (allowed("cancel", "CANCELLED")) actions.push("cancel");
  // Force can reach any other status; the dialog picks which.
  if (can(actor, "order.forceStatus")) actions.push("forceStatus");
  return actions;
}
