import { boxes } from "./boxes";
import { invitations } from "./invitations";
import { me } from "./me";
import { notes } from "./notes";
import { orders } from "./orders";
import { picking } from "./picking";
import { priorityRules } from "./priority-rules";
import { settings } from "./settings";
import { station, stations } from "./stations";
import { sync } from "./sync";
import { users } from "./users";

export * from "./base";
export * from "./boxes";
export * from "./invitations";
export * from "./me";
export * from "./notes";
export * from "./orders";
export * from "./picking";
export * from "./priority-rules";
export * from "./settings";
export * from "./stations";
export * from "./sync";
export * from "./users";

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
  priorityRules,
  sync,
  users,
  invitations,
  stations,
  station,
};
export type Contract = typeof contract;
