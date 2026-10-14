import { archiveBox, createBox, listBoxes, permissionsFor } from "@woolrus/core";
import { db } from "@woolrus/db";
import { api } from "./orpc";

// Thin by design: parse (done by the contract), call core, return. No rules live here.
export const router = api.router({
  me: {
    get: api.me.get.handler(({ context: { user, actor } }) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      roles: user.roles,
      permissions: permissionsFor(user.roles),
      locale: user.locale,
      theme: user.theme,
      stationId: actor.stationId,
    })),
  },
  boxes: {
    list: api.boxes.list.handler(({ input, context }) => listBoxes(db, context.actor, input)),
    create: api.boxes.create.handler(({ input, context }) => createBox(db, context.actor, input)),
    archive: api.boxes.archive.handler(({ input, context }) =>
      archiveBox(db, context.actor, input),
    ),
  },
});

export type Router = typeof router;
