import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { randomUUID } from "./uuid";

const isUuidV4 = (value: string) => z.uuid({ version: "v4" }).safeParse(value).success;

describe("randomUUID", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses crypto.randomUUID when the context has it", () => {
    expect(isUuidV4(randomUUID())).toBe(true);
  });

  it("falls back to getRandomValues outside a secure context", () => {
    const { getRandomValues } = crypto;
    vi.stubGlobal("crypto", { getRandomValues: getRandomValues.bind(crypto) });
    const ids = Array.from({ length: 50 }, randomUUID);
    expect(ids.every(isUuidV4)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
