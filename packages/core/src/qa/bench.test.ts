import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { verifiedQaOrder } from "../../test/qa-fixtures";
import { FakeShipStationProvider } from "../adapters/shipping/fake";
import { createMemoryStorage } from "../adapters/storage/memory";
import { completeQaWithLabels } from "./complete";
import { purchaseLabels } from "./purchase";
import { getQaScreen } from "./queries";

// SPEC-qa criterion 17. The budgets are the spec's; a machine under load can miss them, so the
// samples are few and the check is p95.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'labels.purchase'`);
});

const p95 = (ms: number[]) => [...ms].sort((a, b) => a - b)[Math.ceil(ms.length * 0.95) - 1] ?? 0;

async function time<T>(run: () => Promise<T>): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

describe("QA performance", () => {
  it("Complete QA returns in under 300 ms p95", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const { qa, order } = await verifiedQaOrder(db, 3);
      samples.push(
        await time(() =>
          completeQaWithLabels(db, qa, { orderId: order.id, expectedVersion: order.version }),
        ),
      );
    }
    expect(p95(samples)).toBeLessThan(300);
  }, 60_000);

  it("a 3-package order is Ready in under 5 s with 2 s fakes, buying in parallel", async () => {
    const { qa, order } = await verifiedQaOrder(db, 3);
    await completeQaWithLabels(db, qa, { orderId: order.id, expectedVersion: order.version });
    const provider = new FakeShipStationProvider({ latencyMs: 2000 });
    const elapsed = await time(() =>
      purchaseLabels(
        db,
        { providers: [provider], storage: createMemoryStorage() },
        { orderId: order.id, requestedById: qa.userId },
      ),
    );
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("READY");
    expect(elapsed).toBeLessThan(5000);
  }, 30_000);

  it("qa.screen returns in under 300 ms p95 for 5 packages × 10 rows", async () => {
    const qa = await createActor(db, ["QA"]);
    const built = await createOrder(db, {
      status: "QA",
      claimedById: qa.userId,
      claimedAt: new Date(),
      lines: Array.from({ length: 10 }, () => ({ quantity: 5, pickStatus: "PICKED" as const })),
      packages: Array.from({ length: 5 }, () => ({
        items: Array.from({ length: 10 }, (_, line) => ({ line, quantity: 1 })),
        rates: [{ selected: true }, { selected: false }],
      })),
    });
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push(await time(() => getQaScreen(db, qa, { orderId: built.order.id })));
    }
    expect(p95(samples)).toBeLessThan(300);
  }, 60_000);
});
