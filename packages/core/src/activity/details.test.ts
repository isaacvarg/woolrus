import { describe, expect, it } from "vitest";
import { cleanDetails } from "./details";

describe("cleanDetails", () => {
  it("keeps what changed, without ids, versions, secrets or customer details", () => {
    expect(
      cleanDetails(
        {
          id: "x",
          packageId: "p",
          order_id: "o",
          version: 3,
          weightOz: 36,
          customerEmail: "a@b.c",
          shippingAddress: { city: "Austin" },
          apiKey: "k",
          box: { name: "Small", boxId: "b" },
          items: [{ orderItemId: "i", quantity: 2 }],
        },
        { version: 4, weightOz: 41, reason: "Heavier jar", pin: "1234" },
      ),
    ).toEqual({
      before: { weightOz: 36, box: { name: "Small" }, items: [{ quantity: 2 }] },
      after: { weightOz: 41, reason: "Heavier jar" },
    });
  });

  it("is null when nothing is left to show", () => {
    expect(cleanDetails({ version: 1, claimedById: "u" }, { version: 2 })).toBeNull();
    expect(cleanDetails(null, null)).toBeNull();
  });

  it("keeps a side that was empty as null", () => {
    expect(cleanDetails(null, { status: "QA" })).toEqual({ before: null, after: { status: "QA" } });
  });
});
