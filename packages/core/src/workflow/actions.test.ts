import type { OrderAction } from "@woolrus/contracts";
import type { Role, WorkflowStatus } from "@woolrus/db";
import { describe, expect, it } from "vitest";
import type { Actor } from "../permissions";
import { allowedActions } from "./actions";

const me = "0199e6a0-0000-7000-8000-00000000000a";
const other = "0199e6a0-0000-7000-8000-00000000000b";

const actor = (...roles: Role[]): Actor => ({ userId: me, roles, stationId: null });

type Claim = "none" | "mine" | "other";

function actions(
  roles: Role[],
  status: WorkflowStatus,
  claim: Claim = "none",
  heldFromStatus: WorkflowStatus | null = status === "ON_HOLD" ? "PACKING" : null,
): OrderAction[] {
  const liveClaimHolderId = claim === "mine" ? me : claim === "other" ? other : null;
  return allowedActions(actor(...roles), { status, heldFromStatus, liveClaimHolderId }).sort();
}

const sorted = (...a: OrderAction[]) => [...a].sort();

describe("allowedActions", () => {
  it("gives a Picker begin picking, claim and hold on a free Pending order", () => {
    expect(actions(["PICKER"], "PENDING")).toEqual(sorted("beginPicking", "claim", "hold"));
  });

  it("lets the claim holder complete their stage and release, not re-claim", () => {
    expect(actions(["PICKER"], "PICKING", "mine")).toEqual(
      sorted("completePicking", "release", "hold"),
    );
    expect(actions(["PACKER"], "PACKING", "mine")).toEqual(
      sorted("completePacking", "release", "hold"),
    );
    expect(actions(["QA"], "QA", "mine")).toEqual(sorted("completeQa", "release", "hold"));
  });

  it("offers take over, not claim or complete, when someone else holds it", () => {
    expect(actions(["PACKER"], "PACKING", "other")).toEqual(sorted("takeOver", "hold"));
  });

  it("offers claim but not complete on a free order in the actor's stage", () => {
    expect(actions(["PACKER"], "PACKING")).toEqual(sorted("claim", "hold"));
  });

  it("gives other roles only hold in a stage that isn't theirs", () => {
    expect(actions(["PICKER"], "PACKING")).toEqual(["hold"]);
    expect(actions(["SHIPPER"], "QA", "other")).toEqual(["hold"]);
    expect(actions(["PACKER"], "PENDING")).toEqual(["hold"]);
  });

  it("offers resume on a held order, and nothing claim-related", () => {
    expect(actions(["PICKER"], "ON_HOLD")).toEqual(["resume"]);
    expect(actions(["PICKER"], "ON_HOLD", "none", null)).toEqual([]);
  });

  it("offers nothing on Ready to floor roles but hold (ship and repack belong to shipping)", () => {
    expect(actions(["SHIPPER", "PACKER"], "READY")).toEqual(["hold"]);
  });

  it("offers nothing on terminal orders except to an Admin, who can force", () => {
    for (const status of ["COMPLETED", "CANCELLED"] as const) {
      expect(actions(["PICKER", "PACKER", "QA", "SHIPPER"], status)).toEqual([]);
      expect(actions(["ADMIN"], status)).toEqual(["forceStatus"]);
    }
  });

  it("gives an Admin cancel and force, and release of someone else's claim", () => {
    expect(actions(["ADMIN"], "PACKING", "other")).toEqual(
      sorted("takeOver", "release", "hold", "cancel", "forceStatus"),
    );
    expect(actions(["ADMIN"], "ON_HOLD")).toEqual(sorted("resume", "cancel", "forceStatus"));
    expect(actions(["ADMIN"], "READY")).toEqual(sorted("hold", "cancel", "forceStatus"));
  });

  it("combines roles", () => {
    expect(actions(["PICKER", "PACKER"], "PACKING", "mine")).toEqual(
      sorted("completePacking", "release", "hold"),
    );
  });
});
