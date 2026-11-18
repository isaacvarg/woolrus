"use client";

import {
  type ActivityItem,
  type ActivityParams,
  type ActivityTarget,
  activityMessageKey,
} from "@woolrus/contracts";
import { useTranslations } from "next-intl";

type T = ReturnType<typeof useTranslations>;

/**
 * Parameters the server sends as codes, worded before they go into the action's message. Keyed by
 * parameter name; a module whose wording needs another code translated adds it here.
 */
const paramFormatters: Record<string, (value: string, t: T) => string> = {
  from: (status, t) => (t.has(`status.${status}`) ? t(`status.${status}` as never) : status),
  to: (status, t) => (t.has(`status.${status}`) ? t(`status.${status}` as never) : status),
};

function wordParams(params: ActivityParams, t: T): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => {
      if (value === null) return [key, t("activity.noValue")];
      const format = paramFormatters[key];
      return [key, format && typeof value === "string" ? format(value, t) : value];
    }),
  );
}

/** Words timeline entries: the action's message, or "Changed <entity>" when it has none yet. */
export function useActivityWording() {
  const t = useTranslations();

  const message = (item: ActivityItem): string => {
    // Like `actionSpec` in core: `<EntityType>.<action>` first, for bare verbs like a note's `create`.
    const key = [`${item.entityType}.${item.action}`, item.action]
      .map(activityMessageKey)
      .find((k) => t.has(k));
    if (key) return t(key as never, wordParams(item.params, t) as never);
    const entity = `activity.entity.${item.entityType}`;
    return t("activity.generic", {
      entity: t.has(entity) ? t(entity as never) : t("activity.entity.other"),
    });
  };

  const target = (value: ActivityTarget): string => {
    switch (value.kind) {
      case "line":
        return value.name;
      case "box":
        return t("activity.target.box", { number: value.number });
      case "label":
        return value.trackingEnd
          ? t("activity.target.labelTracking", { carrier: value.carrier, end: value.trackingEnd })
          : t("activity.target.label", { carrier: value.carrier });
    }
  };

  const who = (item: ActivityItem): string | null => {
    if (item.actor) return item.actor.name;
    const system = `activity.system.${item.system ?? "unknown"}`;
    return t.has(system) ? t(system as never) : t("activity.system.unknown");
  };

  return { message, target, who };
}
