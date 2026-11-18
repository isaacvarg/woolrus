import { problemTarget } from "./problems";
import { defineActions } from "./types";

// Notes. Their audit actions are bare verbs, so the keys carry the entity type. The note's text
// never goes in the feed (`details: false`): the entry links to the Notes tab, which applies the
// note rules.

export const noteActions = defineActions({
  "Note.create": {
    category: "notes",
    groups: false,
    details: false,
    describe: (row, ctx) => ({ target: problemTarget(row, ctx) }),
  },
  "Note.update": { category: "notes", groups: true, details: false },
  "Note.delete": { category: "notes", groups: false, details: false },
});
