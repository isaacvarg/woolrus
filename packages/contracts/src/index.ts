import { boxes } from "./boxes";
import { carriers } from "./carriers";
import { invitations } from "./invitations";
import { issues } from "./issues";
import { me } from "./me";
import { notes } from "./notes";
import { orders } from "./orders";
import { packing } from "./packing";
import { pickBatches, picking } from "./picking";
import { priorityRules } from "./priority-rules";
import { qa } from "./qa";
import { settings } from "./settings";
import { station, stations } from "./stations";
import { sync } from "./sync";
import { users } from "./users";
import { voids } from "./voids";

export * from "./base";
export * from "./boxes";
export * from "./carriers";
export * from "./invitations";
export * from "./issues";
export * from "./me";
export * from "./notes";
export * from "./orders";
export * from "./packing";
export * from "./picking";
export * from "./priority-rules";
export * from "./qa";
export * from "./settings";
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
  settings,
  orders,
  notes,
  picking,
  packing,
  qa,
  pickBatches,
  priorityRules,
  sync,
  users,
  invitations,
  stations,
  station,
  voids,
  issues,
  carriers,
};
export type Contract = typeof contract;
