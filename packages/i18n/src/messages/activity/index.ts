import notes from "./notes.json" with { type: "json" };
import packing from "./packing.json" with { type: "json" };
import picking from "./picking.json" with { type: "json" };
import problems from "./problems.json" with { type: "json" };
import qa from "./qa.json" with { type: "json" };
import scanMisses from "./scan-misses.json" with { type: "json" };
import shipping from "./shipping.json" with { type: "json" };
import status from "./status.json" with { type: "json" };
import store from "./store.json" with { type: "json" };

// The order timeline's action wording (`activity.action.*`), one file per category so each module
// words its own actions without touching the others' lines. Keys are `actionMessageKey` in core:
// the action with dots as underscores.

type Part = { en: Record<string, string>; es: Record<string, string> };
const parts: Part[] = [status, picking, packing, qa, shipping, problems, scanMisses, notes, store];

export const activityActions = {
  en: Object.assign({}, ...parts.map((part) => part.en)) as Record<string, string>,
  es: Object.assign({}, ...parts.map((part) => part.es)) as Record<string, string>,
};
