import { boxes } from "./boxes";
import { me } from "./me";

export * from "./base";
export * from "./boxes";
export * from "./me";

/**
 * The whole API surface. Web and (later) Android clients are generated or typed from this;
 * apps/web implements it. Adding a procedure here is the only way to add an endpoint.
 */
export const contract = { me, boxes };
export type Contract = typeof contract;
