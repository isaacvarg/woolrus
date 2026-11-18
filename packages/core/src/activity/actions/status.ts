import { transitionKinds } from "../../workflow/machine";
import { type ActionSpec, defineActions, field } from "./types";

// Status: stage moves, holds, cancels, forced moves and claims (SPEC-order-activity "Action registry").

/** A move writes a stage event and an `order.<kind>` audit row; the stage event is the entry. */
const moves = Object.fromEntries(
  transitionKinds.map((kind) => [
    `order.${kind}`,
    { category: "status", groups: false, hidden: true } satisfies ActionSpec,
  ]),
) as Record<`order.${(typeof transitionKinds)[number]}`, ActionSpec>;

export const statusActions = defineActions({
  /** Stage events (not audit rows): `from` → `to`, with the move's reason. */
  "stage.move": { category: "status", groups: false },
  /** The import's stage event: no `from`. */
  "stage.import": { category: "status", groups: false },
  "order.claim": { category: "status", groups: false },
  "order.takeOver": {
    category: "status",
    groups: false,
    describe: (row, ctx) => {
      const previous = field(row.before, "claimedById");
      return { params: { name: (previous && ctx.userName(String(previous))) || null } };
    },
  },
  "order.release": { category: "status", groups: false },
  ...moves,
});
