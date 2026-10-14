import { boxes } from "./boxes";
import { me } from "./me";
import { settings } from "./settings";

export * from "./base";
export * from "./boxes";
export * from "./me";
export * from "./settings";

/**
 * The whole API surface. Web and (later) Android clients are generated or typed from this;
 * apps/web implements it. Adding a procedure here is the only way to add an endpoint.
 */
export const contract = { me, boxes, settings };
export type Contract = typeof contract;
