import { expect, test } from "@playwright/test";
import en from "@woolrus/i18n/messages/en.json" with { type: "json" };
import { signInAs } from "./support/auth";

test("invalid input comes back as field-level message keys", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  const response = await page.request.post("/api/v1/boxes", {
    data: {
      idempotencyKey: "key-validation",
      name: "Bad box",
      lengthIn: -1,
      widthIn: 2,
      heightIn: 2,
    },
  });

  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.data).toEqual({
    messageKey: "errors.validation",
    fields: { lengthIn: "errors.field.tooSmall" },
  });
  // Clients translate what they get, so every key must exist in the catalog.
  expect(en.errors.field.tooSmall).toBeTruthy();
});
