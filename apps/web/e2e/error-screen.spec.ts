import { createServer } from "node:http";
import { expect, type Page, test } from "@playwright/test";
import { signInAs } from "./support/auth";

/** Makes the boxes page throw while rendering: the list answers with a row that is null. */
async function breakBoxesList(page: Page) {
  await page.route("**/rpc/boxes/list", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: [null] }) }),
  );
}

test("a render error shows the translated error screen", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await breakBoxesList(page);
  await page.goto("/boxes");
  const screen = page.getByRole("alert");
  await expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});

// Needs SENTRY_DSN on the server under test and in this process, pointing at a free local port.
test("a browser error reaches the ingest through /api/errors with service and user tags", async ({
  page,
}, info) => {
  test.skip(!process.env.SENTRY_DSN, "SENTRY_DSN is not set");
  // One project only: both would listen on the DSN's port.
  test.skip(info.project.name !== "desktop", "desktop project only");
  const port = Number(new URL(process.env.SENTRY_DSN ?? "").port);
  const events: { tags?: Record<string, string>; request?: unknown }[] = [];
  const ingest = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const lines = Buffer.concat(chunks).toString().split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if ((JSON.parse(lines[i] || "{}") as { type?: string }).type === "event") {
          events.push(JSON.parse(lines[i + 1] || "{}"));
        }
      }
      res.end("{}");
    });
  });
  await new Promise<void>((ok) => ingest.listen(port, "127.0.0.1", ok));
  try {
    const user = await signInAs(page, ["ADMIN"]);
    await breakBoxesList(page);
    await page.goto("/boxes");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect
      .poll(() => events.find((e) => e.tags?.userId === user.id)?.tags, { timeout: 10_000 })
      .toMatchObject({ service: "web-browser", userId: user.id });
  } finally {
    ingest.close();
  }
});
