import { defineActions } from "./types";

// Problems: voids and quality issues; none of them group. Wording comes with #203. Scan misses
// are Problems too, but come from their own source and file (#205).

export const problemActions = defineActions({
  "void.create": { category: "problems", groups: false },
  "void.undo": { category: "problems", groups: false },
  "void.resolve": { category: "problems", groups: false },
  "issue.report": { category: "problems", groups: false },
  "issue.update": { category: "problems", groups: false },
  "issue.setResponsible": { category: "problems", groups: false },
  "issue.resolve": { category: "problems", groups: false },
  "issue.reopen": { category: "problems", groups: false },
  "issue.delete": { category: "problems", groups: false },
  "issue.linkRepack": { category: "problems", groups: false },
});
