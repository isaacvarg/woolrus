import { auditRowSource } from "./audit-rows";
import { scanMissSource } from "./scan-misses";
import { stageEventSource } from "./stage-events";
import type { ActivitySource } from "./types";

export type { ActivitySource, SourceRecord } from "./types";

/** What the order timeline merges. A new kind of record adds its source here, in its own file. */
export const activitySources: readonly ActivitySource[] = [
  stageEventSource,
  auditRowSource,
  scanMissSource,
];
