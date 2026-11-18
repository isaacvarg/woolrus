import { ThroughputStage, UsersExportInput } from "@woolrus/contracts";
import type { DbTx } from "@woolrus/db";
import type { CsvCell } from "../csv";
import { isStationOnly, publicEmail } from "../identity/station-only";
import { type Actor, assertCan } from "../permissions";
import type { CsvExport } from "../rate-lab/exports";
import { type ExportOptions, exportKit, parseExportInput, type QueryOf } from "./exports";
import { quality } from "./quality";
import { throughput } from "./throughput";

// The users export (SPEC-reporting "CSV exports"): one row per user, deactivated and station-only
// ones included, with their account columns and, for the range, orders and units per stage,
// issues they were responsible for and their blocked scans. The figures come from the Throughput
// and Quality reads themselves (with no filters), so the file always agrees with those screens.
// Staff emails are in it; a station-only user's placeholder address never leaves core.

const COLUMNS = [
  "name",
  "email",
  "roles",
  "active",
  "stationOnly",
  "created",
  "pickingOrders",
  "pickingUnits",
  "packingOrders",
  "packingUnits",
  "qaOrders",
  "qaUnits",
  "shippingOrders",
  "shippingUnits",
  "issuesResponsible",
  "blockedScans",
] as const;

type Work = { orders: number; units: number };

/** Every user with their work over the range, by name; `report.read`. */
export async function usersCsv(
  db: DbTx,
  actor: Actor,
  input: QueryOf<typeof UsersExportInput>,
  options: ExportOptions,
): Promise<CsvExport> {
  assertCan(actor, "report.read");
  const range = parseExportInput(UsersExportInput, input);
  const kit = exportKit("users", range.timeZone, options);
  const [users, work, issues] = await Promise.all([
    db.user.findMany({
      select: { id: true, name: true, email: true, roles: true, active: true, createdAt: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: kit.max + 1,
    }),
    throughput(db, actor, range),
    quality(db, actor, range),
  ]);

  const stages = new Map<string, Work>();
  for (const t of work.people)
    if (t.person.id) stages.set(`${t.stage}:${t.person.id}`, { orders: t.orders, units: t.units });
  const issueCounts = new Map(issues.byPerson.totals.map((t) => [t.key, t.count]));
  const scanCounts = new Map<string, number>();
  for (const s of issues.scans)
    if (s.person.id)
      scanCounts.set(
        s.person.id,
        (scanCounts.get(s.person.id) ?? 0) +
          s.notOnOrder +
          s.alreadyDone +
          s.otherPackage +
          s.unknownCode,
      );

  async function* rows(): AsyncGenerator<readonly CsvCell[]> {
    for (const u of users) {
      const perStage = ThroughputStage.options.flatMap((stage) => {
        const w = stages.get(`${stage}:${u.id}`);
        return [w?.orders ?? 0, w?.units ?? 0];
      });
      yield [
        u.name.trim(),
        publicEmail(u.email),
        u.roles.join(" "),
        kit.yesNo(u.active),
        kit.yesNo(isStationOnly(u.email)),
        kit.time(u.createdAt),
        ...perStage,
        issueCounts.get(u.id) ?? 0,
        scanCounts.get(u.id) ?? 0,
      ];
    }
  }
  return {
    filename: `woolrus-users-${range.from}-${range.to}.csv`,
    header: kit.header(COLUMNS),
    rows: kit.capped(rows()),
  };
}
