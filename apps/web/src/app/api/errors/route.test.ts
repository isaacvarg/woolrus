import { describe, expect, it } from "vitest";
import { POST } from "./route";

// The tunnel answers 204 whatever happens (SPEC-operations "Tunnel", criterion 4).

const post = (body: string) => new Request("http://woolrus/api/errors", { method: "POST", body });

describe("POST /api/errors", () => {
  it("answers 204 with no body when nothing is configured", async () => {
    const response = await POST(post('{"dsn":"http://k@x/1"}\n{"type":"event"}\n{}'));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("answers 204 for garbage, and for an oversized body", async () => {
    for (const body of ["not json", "x".repeat(200 * 1024)]) {
      expect((await POST(post(body))).status).toBe(204);
    }
  });
});
