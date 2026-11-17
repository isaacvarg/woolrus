import { defineActions } from "./types";

// Notes. Their audit actions are bare verbs, so the keys carry the entity type. Wording and the
// link to the Notes tab come with #203; note text never goes in the feed.

export const noteActions = defineActions({
  "Note.create": { category: "notes", groups: false },
  "Note.update": { category: "notes", groups: true },
  "Note.delete": { category: "notes", groups: false },
});
