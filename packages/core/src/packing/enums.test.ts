import { PackCheck, PackCheckMode, QaBoxConfirm } from "@woolrus/contracts";
import {
  PackCheck as DbPackCheck,
  PackCheckMode as DbPackCheckMode,
  QaBoxConfirm as DbQaBoxConfirm,
} from "@woolrus/db";
import { describe, expect, it } from "vitest";

// The zod enums the API speaks and the database enums they're stored in must hold the same values:
// the compiler catches a value zod gains, not one only the database gains (`packCheckStats` would
// silently drop it, as it iterates `PackCheck.options`).

describe("packing check enums match the database", () => {
  it.each([
    ["PackCheck", PackCheck.options, DbPackCheck],
    ["PackCheckMode", PackCheckMode.options, DbPackCheckMode],
    ["QaBoxConfirm", QaBoxConfirm.options, DbQaBoxConfirm],
  ] as const)("%s", (_, zod, db) => {
    expect([...zod].sort()).toEqual(Object.values(db).sort());
  });
});
