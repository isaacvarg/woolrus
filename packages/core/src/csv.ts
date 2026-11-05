// CSV exports (FR-REP-04): RFC 4180 quoting with CRLF line ends, UTF-8 with a BOM so Excel reads
// it as UTF-8, and rows streamed as they are produced.

export type CsvCell = string | number | null;

const BOM = "﻿";
/**
 * A spreadsheet treats a cell starting with one of these as a formula (CSV injection); OWASP adds
 * tab and carriage return, which some spreadsheets skip before reading a formula.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;
const CHUNK = 64 * 1024;

/** One cell: numbers as they are, null as empty, text defused and quoted when it must be. */
export function csvCell(value: CsvCell): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const csvLine = (cells: readonly CsvCell[]) => `${cells.map(csvCell).join(",")}\r\n`;

/** The BOM and header, then one line per row as `rows` yields them. */
export function csvStream(
  header: readonly string[],
  rows: AsyncIterable<readonly CsvCell[]> | Iterable<readonly CsvCell[]>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  async function* lines() {
    yield BOM + csvLine(header);
    for await (const row of rows) yield csvLine(row);
  }
  const iterator = lines();
  return new ReadableStream({
    // Lines go out in chunks of about CHUNK characters rather than one write each.
    async pull(controller) {
      let chunk = "";
      while (chunk.length < CHUNK) {
        const next = await iterator.next();
        if (next.done) {
          if (chunk) controller.enqueue(encoder.encode(chunk));
          controller.close();
          return;
        }
        chunk += next.value;
      }
      controller.enqueue(encoder.encode(chunk));
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}
