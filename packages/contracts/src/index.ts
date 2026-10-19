import { boxes } from "./boxes";
import { me } from "./me";
import { orders } from "./orders";
import { priorityRules } from "./priority-rules";
import { settings } from "./settings";
import { sync } from "./sync";

export * from "./base";
export * from "./boxes";
export * from "./me";
export * from "./orders";
export * from "./priority-rules";
export * from "./settings";
export * from "./sync";

/**
 * The whole API surface. Web and (later) Android clients are generated or typed from this;
 * apps/web implements it. Adding a procedure here is the only way to add an endpoint.
 */
export const contract = { me, boxes, settings, orders, priorityRules, sync };
export type Contract = typeof contract;
