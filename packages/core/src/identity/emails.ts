import { type Locale, type MessageKey, messages } from "@woolrus/i18n";

// App email templates: plain HTML + text, strings from @woolrus/i18n in the recipient's locale
// (SPEC-identity "Email"). Params fill `{name}` placeholders and are HTML-escaped in the HTML part.

type Template = {
  subject: MessageKey;
  paragraphs: readonly MessageKey[];
  /** A link button after the first paragraph; its URL comes from the `url` param. */
  action?: MessageKey;
};

const templates = {
  test: { subject: "emails.test.subject", paragraphs: ["emails.test.body"] },
  invitation: {
    subject: "emails.invitation.subject",
    paragraphs: ["emails.invitation.body", "emails.invitation.expiry"],
    action: "emails.invitation.action",
  },
} as const satisfies Record<string, Template>;

export type EmailTemplate = keyof typeof templates;

export type RenderedEmail = { subject: string; html: string; text: string };

function lookup(locale: Locale, key: MessageKey): string {
  let node: unknown = messages[locale];
  for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
  return node as string;
}

const fill = (message: string, params: Record<string, string>) =>
  message.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function renderEmail(
  template: EmailTemplate,
  params: Record<string, string>,
  locale: Locale,
): RenderedEmail {
  const { subject, paragraphs, ...rest } = templates[template] as Template;
  const escaped = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, escapeHtml(v)]));
  const text = paragraphs.map((key) => fill(lookup(locale, key), params));
  const html = paragraphs.map((key) => `<p>${fill(escapeHtml(lookup(locale, key)), escaped)}</p>`);
  if (rest.action && params.url) {
    const label = lookup(locale, rest.action);
    text.splice(1, 0, `${label}: ${params.url}`);
    html.splice(1, 0, `<p><a href="${escaped.url}">${escapeHtml(label)}</a></p>`);
  }
  return {
    subject: fill(lookup(locale, subject), params),
    html: `<!doctype html><html lang="${locale}"><body>${html.join("")}</body></html>`,
    text: text.join("\n\n"),
  };
}
