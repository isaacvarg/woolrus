import { boxes } from "./boxes";
import { me } from "./me";
import { orders } from "./orders";
import { settings } from "./settings";

export * from "./base";
export * from "./boxes";
export * from "./me";
export * from "./orders";
export * from "./priority-rules";
export * from "./settings";

/**
 * The whole API surface. Web and (later) Android clients are generated or typed from this;
 * apps/web implements it. Adding a procedure here is the only way to add an endpoint.
 */
export const contract = { me, boxes, settings, orders };
export type Contract = typeof contract;
