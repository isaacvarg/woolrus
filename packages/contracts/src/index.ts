import { approvers } from "./approvals";
import { boxes, boxGroups } from "./boxes";
import { carriers } from "./carriers";
import { invitations } from "./invitations";
import { issues } from "./issues";
import { lumexia } from "./lumexia";
import { me } from "./me";
import { notes } from "./notes";
import { operations } from "./operations";
import { orders } from "./orders";
import { packChecks } from "./pack-checks";
import { packing } from "./packing";
import { pickBatches, picking } from "./picking";
import { priorityRules } from "./priority-rules";
import { qa } from "./qa";
import { rateLab } from "./rate-lab";
import { reports } from "./reports";
import { settings } from "./settings";
import { shipping } from "./shipping";
import { station, stations } from "./stations";
import { sync } from "./sync";
import { users } from "./users";
import { voids } from "./voids";

export * from "./approvals";
export * from "./base";
export * from "./boxes";
export * from "./carriers";
export * from "./invitations";
export * from "./issues";
export * from "./lumexia";
export * from "./me";
export * from "./notes";
export * from "./operations";
export * from "./order-activity";
export * from "./orders";
export * from "./pack-checks";
export * from "./packing";
export * from "./picking";
export * from "./priority-rules";
export * from "./qa";
export * from "./rate-lab";
export * from "./rate-lab-real-orders";
export * from "./rate-lab-run";
export * from "./rate-lab-trends";
export * from "./reports";
export * from "./settings";
export * from "./shipping";
export * from "./stations";
export * from "./sync";
export * from "./users";
export * from "./voids";

/**
 * The whole API surface. Web and (later) Android clients are generated or typed from this;
 * apps/web implements it. Adding a procedure here is the only way to add an endpoint.
 */
export const contract = {
  me,
  boxes,
  boxGroups,
  settings,
  orders,
  notes,
  picking,
  packing,
  packChecks,
  qa,
  pickBatches,
  priorityRules,
  sync,
  users,
  invitations,
  stations,
  station,
  approvers,
  voids,
  issues,
  carriers,
  operations,
  shipping,
  rateLab,
  lumexia,
  reports,
};
export type Contract = typeof contract;
