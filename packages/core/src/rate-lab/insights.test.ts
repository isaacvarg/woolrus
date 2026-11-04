import type { LabQuote } from "@woolrus/contracts";
import { describe, expect, it } from "vitest";
import { type InsightCombination, PRICE_MOVE_PCT, runInsights } from "./insights";

// SPEC-rate-lab criterion 11: the run page's insights, from hand-built quotes. No database.

let n = 0;
const id = () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
const ground = { carrierId: id(), serviceId: id() };
const express = { carrierId: ground.carrierId, serviceId: id() };
const bridge = { carrierId: id(), serviceId: id() };

function quote(
  service: { carrierId: string; serviceId: string },
  amountCents: number,
  fields: Partial<LabQuote> = {},
): LabQuote {
  const name =
    service === ground ? "Ground" : service === express ? "Express" : `Bridge ${service.serviceId}`;
  return {
    id: id(),
    provider: service === bridge ? "BRIDGE_SOURCE" : "SHIPSTATION",
    ...service,
    carrierName: service === bridge ? "Bridge" : "Demo",
    serviceCode: name.toLowerCase(),
    serviceName: name,
    amountCents,
    currency: "USD",
    deliveryDays: null,
    guaranteed: false,
    quoteOnly: false,
    fake: true,
    ...fields,
  };
}

const combination = (
  key: string,
  quotes: LabQuote[],
  errors: InsightCombination["errors"] = [],
): InsightCombination => ({ key, quotes, errors });

const none = new Map<string, InsightCombination>();

describe("cheapest and fastest", () => {
  it("prefers a purchasable quote over a cheaper quote-only one", () => {
    const quoteOnly = quote(bridge, 500, { quoteOnly: true });
    const buyable = quote(ground, 900);
    const { picks } = runInsights([combination("a", [quoteOnly, buyable])], none);
    expect(picks).toEqual([
      expect.objectContaining({
        key: "a",
        cheapestId: buyable.id,
        cheapestQuoteOnly: false,
        failed: false,
      }),
    ]);
  });

  it("falls back to quote-only quotes, marked, when nothing can be bought", () => {
    const cheap = quote(bridge, 500, { quoteOnly: true, deliveryDays: 5 });
    const quick = quote(bridge, 800, { quoteOnly: true, deliveryDays: 2 });
    const [pick] = runInsights([combination("a", [quick, cheap])], none).picks;
    expect(pick).toMatchObject({
      cheapestId: cheap.id,
      cheapestQuoteOnly: true,
      fastestId: quick.id,
      fastestQuoteOnly: true,
    });
  });

  it("takes the fewest delivery days, then the lower price, ignoring unknown days", () => {
    const unknown = quote(ground, 100);
    const twoDear = quote(express, 1500, { deliveryDays: 2 });
    const twoCheap = quote(bridge, 1200, { deliveryDays: 2 });
    const five = quote(ground, 300, { deliveryDays: 5 });
    const [pick] = runInsights([combination("a", [unknown, twoDear, five, twoCheap])], none).picks;
    expect(pick).toMatchObject({ cheapestId: unknown.id, fastestId: twoCheap.id });
  });

  it("has no fastest when no quote knows its delivery days", () => {
    const [pick] = runInsights([combination("a", [quote(ground, 100)])], none).picks;
    expect(pick?.fastestId).toBeNull();
  });

  it("lists a combination with no quotes as failed", () => {
    const [pick] = runInsights(
      [combination("a", [], [{ provider: "SHIPSTATION", messageKey: "errors.carriers.timeout" }])],
      none,
    ).picks;
    expect(pick).toEqual({
      key: "a",
      cheapestId: null,
      cheapestQuoteOnly: false,
      fastestId: null,
      fastestQuoteOnly: false,
      failed: true,
    });
  });
});

describe("price moves", () => {
  const earlier = (quotes: LabQuote[]) => new Map([["a", combination("a", quotes)]]);

  it(`flags a move of ${PRICE_MOVE_PCT}% or more, up or down, and not a 9.9% one`, () => {
    const { moves } = runInsights(
      [combination("a", [quote(ground, 1100), quote(express, 1099), quote(bridge, 900)])],
      earlier([quote(ground, 1000), quote(express, 1000), quote(bridge, 1000)]),
    );
    expect(moves).toEqual([
      expect.objectContaining({
        combinationKey: "a",
        kind: "CHANGED",
        serviceId: ground.serviceId,
        previousCents: 1000,
        currentCents: 1100,
        changePct: 10,
      }),
      expect.objectContaining({
        kind: "CHANGED",
        serviceId: bridge.serviceId,
        previousCents: 1000,
        currentCents: 900,
        changePct: -10,
      }),
    ]);
  });

  it("lists new and missing services", () => {
    const { moves } = runInsights(
      [combination("a", [quote(ground, 1000), quote(bridge, 700)])],
      earlier([quote(ground, 1000), quote(express, 2000)]),
    );
    expect(moves).toEqual([
      expect.objectContaining({
        kind: "NEW",
        serviceId: bridge.serviceId,
        serviceName: `Bridge ${bridge.serviceId}`,
        carrierName: "Bridge",
        previousCents: null,
        currentCents: 700,
        changePct: null,
      }),
      expect.objectContaining({
        kind: "MISSING",
        serviceId: express.serviceId,
        serviceName: "Express",
        previousCents: 2000,
        currentCents: null,
        changePct: null,
      }),
    ]);
  });

  it("compares nothing for a combination without an earlier run", () => {
    const { moves } = runInsights(
      [combination("b", [quote(ground, 5000)])],
      earlier([quote(ground, 1000)]),
    );
    expect(moves).toEqual([]);
  });
});

describe("carrier wins and failures", () => {
  it("counts how often each carrier service was cheapest", () => {
    const { carrierWins } = runInsights(
      [
        combination("a", [quote(ground, 500), quote(bridge, 600)]),
        combination("b", [quote(ground, 700), quote(bridge, 600)]),
        combination("c", [quote(ground, 400), quote(express, 900)]),
        combination("d", []),
      ],
      none,
    );
    expect(carrierWins).toEqual([
      expect.objectContaining({ serviceId: ground.serviceId, serviceName: "Ground", wins: 2 }),
      expect.objectContaining({ serviceId: bridge.serviceId, carrierName: "Bridge", wins: 1 }),
    ]);
  });

  it("groups failures per provider, with each error and its combination", () => {
    const { failures } = runInsights(
      [
        combination(
          "a",
          [quote(ground, 500)],
          [{ provider: "BRIDGE_SOURCE", messageKey: "errors.carriers.timeout" }],
        ),
        combination(
          "b",
          [],
          [
            {
              provider: null,
              messageKey: "errors.shipping.customsIncomplete",
              params: { products: "Jar" },
            },
          ],
        ),
        combination(
          "c",
          [],
          [
            { provider: "SHIPSTATION", messageKey: "errors.carriers.unavailable" },
            { provider: "BRIDGE_SOURCE", messageKey: "errors.carriers.badAddress" },
          ],
        ),
      ],
      none,
    );
    expect(failures).toEqual([
      {
        provider: "SHIPSTATION",
        count: 1,
        errors: [{ combinationKey: "c", messageKey: "errors.carriers.unavailable" }],
      },
      {
        provider: "BRIDGE_SOURCE",
        count: 2,
        errors: [
          { combinationKey: "a", messageKey: "errors.carriers.timeout" },
          { combinationKey: "c", messageKey: "errors.carriers.badAddress" },
        ],
      },
      {
        provider: null,
        count: 1,
        errors: [
          {
            combinationKey: "b",
            messageKey: "errors.shipping.customsIncomplete",
            params: { products: "Jar" },
          },
        ],
      },
    ]);
  });
});
