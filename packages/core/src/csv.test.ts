import { describe, expect, it } from "vitest";
import { csvCell, csvLine, csvStream } from "./csv";

// FR-REP-04 exports (SPEC-rate-lab "Exports", criterion 14): RFC 4180, BOM, CSV injection.

async function read(stream: ReadableStream<Uint8Array>) {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    await new Response(stream).arrayBuffer(),
  );
}

describe("csvCell", () => {
  it("quotes only what RFC 4180 needs quoted, doubling quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"');
  });

  it("writes numbers as they are and null as empty", () => {
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
    expect(csvCell("")).toBe("");
  });

  it("prefixes a text cell starting with = + - @ so a spreadsheet won't run it", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell('=A1,"x"')).toBe(`"'=A1,""x"""`);
    expect(csvCell("a=b")).toBe("a=b");
  });
});

describe("csvStream", () => {
  it("starts with a BOM and the header, and ends every line with CRLF", async () => {
    async function* rows() {
      yield ["a", 1];
      yield ["b,c", null];
    }
    const text = await read(csvStream(["Name", "Count"], rows()));
    expect(text).toBe('﻿Name,Count\r\na,1\r\n"b,c",\r\n');
    expect(csvLine(["x", 2])).toBe("x,2\r\n");
  });

  it("sends just the header when there are no rows", async () => {
    expect(await read(csvStream(["Only"], []))).toBe("﻿Only\r\n");
  });
});
