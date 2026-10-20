import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { locales, messages } from "./index";

function entries(obj: object, prefix = ""): [string, string][] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "string" ? [[`${prefix}${k}`, v]] : entries(v, `${prefix}${k}.`),
  );
}

const keys = (obj: object) => entries(obj).map(([key]) => key);

type Element = ReturnType<IntlMessageFormat["getAst"]>[number];

/** Whether an ICU message (or any plural/select branch of it) has a rich-text tag. */
function hasTag(ast: Element[]): boolean {
  return ast.some((element) => {
    if ("children" in element) return true;
    if ("options" in element) {
      return Object.values(element.options).some((option) => hasTag(option.value));
    }
    return false;
  });
}

describe("message catalogs", () => {
  it("es has exactly the same keys as en", () => {
    expect(keys(messages.es).sort()).toEqual(keys(messages.en).sort());
  });

  // Nothing renders with t.rich, so a tag makes next-intl fail and show the bare key instead:
  // a literal "<" or "{" has to be quoted ('<').
  it.each(locales)("every %s message is plain ICU without tags", (locale) => {
    const broken = entries(messages[locale]).filter(([, message]) => {
      try {
        return hasTag(new IntlMessageFormat(message, locale).getAst());
      } catch {
        return true;
      }
    });
    expect(broken.map(([key]) => key)).toEqual([]);
  });
});
