"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminSettings, SecretName } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextField } from "@/components/ui/fields";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

type SettingField = "wooStoreUrl" | "lumexiaBaseUrl" | "emailFrom";

const integrations: { id: string; field?: SettingField; secrets: SecretName[] }[] = [
  {
    id: "woocommerce",
    field: "wooStoreUrl",
    secrets: ["wooConsumerKey", "wooConsumerSecret", "wooWebhookSecret"],
  },
  { id: "lumexia", field: "lumexiaBaseUrl", secrets: ["lumexiaApiKey"] },
  { id: "email", field: "emailFrom", secrets: ["resendApiKey"] },
];

/** The sender address isn't a server: changing it never clears the Resend key. */
const urlFields: ReadonlySet<SettingField> = new Set(["wooStoreUrl", "lumexiaBaseUrl"]);

/** Every settings mutation returns the full admin settings: put them straight into the cache. */
function useApplySettings() {
  const queryClient = useQueryClient();
  return (updated: AdminSettings) =>
    queryClient.setQueryData(orpc.settings.get.queryKey(), updated);
}

export function IntegrationsSection() {
  const t = useTranslations();
  // Same query as the General section, which shows its loading and error states.
  const settings = useQuery(orpc.settings.get.queryOptions());
  if (!settings.data) return null;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">{t("settings.integrations.title")}</h2>
      {integrations.map(({ id, field, secrets }) => (
        <IntegrationCard key={id} name={t(`settings.integrations.names.${id}`)}>
          {field && (
            <SettingForm
              field={field}
              saved={settings.data[field]}
              savedSecrets={
                urlFields.has(field)
                  ? secrets.filter((s) => settings.data.secrets[s]?.configured)
                  : []
              }
            />
          )}
          <div className="divide-y divide-base-200">
            {secrets.map((secret) => (
              <SecretRow
                key={secret}
                name={secret}
                configured={settings.data.secrets[secret]?.configured ?? false}
              />
            ))}
          </div>
          {id === "woocommerce" && <StoreTools />}
          {id === "email" && <EmailTools />}
        </IntegrationCard>
      ))}
    </div>
  );
}

function IntegrationCard({ name, children }: { name: string; children: React.ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="card bg-base-100 shadow-sm">
      <div className="card-body">
        <h3 id={headingId} className="card-title">
          {name}
        </h3>
        {children}
      </div>
    </section>
  );
}

const originOf = (url: string | null) => (url && URL.canParse(url) ? new URL(url).origin : null);

/**
 * Whether saving `next` moves the URL to another server, so the server clears the saved keys
 * (mirrors `updateSettings`: an origin change or a removal; a first URL is not a move).
 */
function movesServer(saved: string | null, next: string | null): boolean {
  if (saved === null) return false;
  if (next === null) return true;
  const origin = originOf(next);
  // An invalid URL is refused by the server and clears nothing.
  return origin !== null && origin !== originOf(saved);
}

/** One text setting of a card. A URL moving to another server first asks to drop its keys. */
function SettingForm({
  field,
  saved,
  savedSecrets,
}: {
  field: SettingField;
  saved: string | null;
  /** This integration's secrets that are set: the ones a move would clear. */
  savedSecrets: SecretName[];
}) {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const applySettings = useApplySettings();
  const [value, setValue] = useState(saved ?? "");
  const [confirming, setConfirming] = useState(false);

  const save = useMutation(
    orpc.settings.update.mutationOptions({
      onSuccess: ({ clearedSecrets: _, ...updated }) => {
        setValue(updated[field] ?? "");
        setConfirming(false);
        applySettings(updated);
      },
    }),
  );
  const errors = fieldErrors(save.error);
  const next = value.trim() === "" ? null : value.trim();
  const submit = () => save.mutate({ [field]: next });

  return (
    <Form
      className="flex flex-wrap items-end gap-x-4"
      validationErrors={errors}
      onSubmit={(event) => {
        event.preventDefault();
        if (savedSecrets.length > 0 && movesServer(saved, next)) setConfirming(true);
        else submit();
      }}
    >
      <div className="min-w-64 flex-1">
        <TextField
          label={t(`settings.integrations.${field}`)}
          name={field}
          inputMode={urlFields.has(field) ? "url" : "email"}
          value={value}
          onChange={(next) => {
            // A server field error is re-applied on every render until the mutation is reset,
            // and it would block the corrected value from submitting.
            if (save.isSuccess || save.isError) save.reset();
            setValue(next);
          }}
        />
      </div>
      <Button type="submit" isPending={save.isPending} className="btn-primary mb-1">
        {t("common.save")}
      </Button>
      {save.error && Object.keys(errors).length === 0 && (
        <p role="alert" className="basis-full text-error">
          {errorMessage(save.error)}
        </p>
      )}
      <p role="status" className="basis-full text-success">
        {save.isSuccess
          ? save.data.clearedSecrets.length > 0
            ? t("settings.integrations.savedKeysCleared")
            : t("settings.integrations.saved")
          : ""}
      </p>
      <Dialog
        title={t("settings.integrations.urlMoveTitle")}
        isOpen={confirming}
        onOpenChange={setConfirming}
      >
        {(close) => (
          <>
            <p>
              {t("settings.integrations.urlMoveBody", {
                secrets: format.list(
                  savedSecrets.map((s) => t(`settings.integrations.secrets.${s}`)),
                  { type: "conjunction" },
                ),
              })}
            </p>
            <div className="flex justify-end gap-2">
              <Button className="btn-ghost" autoFocus onPress={close}>
                {t("common.cancel")}
              </Button>
              <Button className="btn-error" isPending={save.isPending} onPress={submit}>
                {t("settings.integrations.urlMoveConfirm")}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </Form>
  );
}

/** Test connection and the webhook setup, under the WooCommerce card's keys. */
function StoreTools() {
  const t = useTranslations("settings.integrations");
  const errorMessage = useErrorMessage();
  const message = useTranslations();
  const test = useMutation(orpc.sync.testConnection.mutationOptions());
  const [copied, setCopied] = useState(false);
  // Rendered only on the client (the settings query isn't prefetched), so window is there.
  const webhookUrl = `${window.location.origin}/api/webhooks/woocommerce`;

  return (
    <div className="space-y-4 border-t border-base-200 pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button className="btn-outline" isPending={test.isPending} onPress={() => test.mutate({})}>
          {t("testConnection")}
        </Button>
        <span className="text-sm text-base-content/70">{t("testHint")}</span>
        <div aria-live="polite" className="basis-full">
          {test.data?.ok === true && (
            <p className="text-success">
              {t("testOk", {
                weight: test.data.units.weight,
                dimension: test.data.units.dimension,
              })}
            </p>
          )}
          {test.data?.ok === false && (
            <p className="text-error">
              {message.has(test.data.messageKey)
                ? message(test.data.messageKey as never)
                : message("errors.internal")}
            </p>
          )}
          {test.error && <p className="text-error">{errorMessage(test.error)}</p>}
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="font-semibold">{t("webhook.title")}</h4>
        <p className="text-sm text-base-content/70">{t("webhook.intro")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t("webhook.url")}:</span>
          <code className="rounded bg-base-200 px-2 py-1 text-sm break-all">{webhookUrl}</code>
          <Button
            className="btn-ghost btn-sm"
            onPress={async () => {
              await navigator.clipboard.writeText(webhookUrl);
              setCopied(true);
            }}
          >
            {t("webhook.copy")}
          </Button>
          <span role="status" className="text-sm text-success">
            {copied ? t("webhook.copied") : ""}
          </span>
        </div>
        <ol className="list-decimal space-y-1 pl-6 text-sm">
          <li>{t("webhook.step1")}</li>
          <li>{t("webhook.step2")}</li>
          <li>{t("webhook.step3")}</li>
          <li>{t("webhook.step4")}</li>
        </ol>
      </div>
    </div>
  );
}

/** Send test email, under the Email card's key: to the admin's own address. */
function EmailTools() {
  const t = useTranslations("settings.integrations");
  const message = useTranslations();
  const errorMessage = useErrorMessage();
  const test = useMutation(orpc.settings.sendTestEmail.mutationOptions());

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-base-200 pt-4">
      <Button className="btn-outline" isPending={test.isPending} onPress={() => test.mutate({})}>
        {t("sendTestEmail")}
      </Button>
      <span className="text-sm text-base-content/70">{t("sendTestEmailHint")}</span>
      <div aria-live="polite" className="basis-full">
        {test.data?.ok === true && (
          <p className={test.data.via === "resend" ? "text-success" : "text-warning"}>
            {test.data.via === "resend"
              ? t("testEmailSent", { to: test.data.to })
              : t("testEmailLogged", { to: test.data.to })}
          </p>
        )}
        {test.data?.ok === false && (
          <p className="text-error">
            {message.has(test.data.messageKey)
              ? message(test.data.messageKey as never)
              : message("errors.internal")}
          </p>
        )}
        {test.error && <p className="text-error">{errorMessage(test.error)}</p>}
      </div>
    </div>
  );
}

/**
 * One write-only secret: shows only whether it is set. Replacing opens an empty field; the current
 * value is never sent to the browser, so there is nothing to pre-fill.
 */
function SecretRow({ name, configured }: { name: SecretName; configured: boolean }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const applySettings = useApplySettings();
  const labelId = useId();
  const [mode, setMode] = useState<"idle" | "editing" | "confirmingClear">("idle");
  // After the editor or the confirmation closes, keyboard focus goes back to the row's main button
  // (its own button may be gone, e.g. Clear after clearing).
  const mainButton = useRef<HTMLButtonElement>(null);
  const [returnFocus, setReturnFocus] = useState(false);
  useEffect(() => {
    if (mode === "idle" && returnFocus) {
      mainButton.current?.focus();
      setReturnFocus(false);
    }
  }, [mode, returnFocus]);
  const [value, setValue] = useState("");
  const label = t(`settings.integrations.secrets.${name}`);

  const close = () => {
    setReturnFocus(true);
    setValue("");
    setMode("idle");
  };
  const set = useMutation(
    orpc.settings.setSecret.mutationOptions({
      onSuccess: (updated) => {
        applySettings(updated);
        close();
      },
    }),
  );
  const clear = useMutation(
    orpc.settings.clearSecret.mutationOptions({
      onSuccess: (updated) => {
        applySettings(updated);
        close();
      },
    }),
  );
  const open = (next: typeof mode) => {
    set.reset();
    clear.reset();
    setMode(next);
  };
  const error = set.error ?? clear.error;
  const errors = fieldErrors(set.error);

  return (
    <fieldset aria-labelledby={labelId} className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span id={labelId} className="font-medium">
          {label}
        </span>
        <span className={`badge ${configured ? "badge-success" : "badge-ghost"}`}>
          {configured ? t("settings.integrations.set") : t("settings.integrations.notSet")}
        </span>
        {mode === "idle" && (
          <div className="ml-auto flex gap-2">
            <Button ref={mainButton} className="btn-outline btn-sm" onPress={() => open("editing")}>
              {configured ? t("settings.integrations.replace") : t("settings.integrations.add")}
            </Button>
            {configured && (
              <Button
                className="btn-ghost btn-sm text-error"
                onPress={() => open("confirmingClear")}
              >
                {t("settings.integrations.clear")}
              </Button>
            )}
          </div>
        )}
      </div>

      {mode === "editing" && (
        <Form
          className="mt-2"
          validationErrors={errors}
          onSubmit={(event) => {
            event.preventDefault();
            set.mutate({ name, value });
          }}
        >
          <TextField
            label={t("settings.integrations.newValue")}
            description={t("settings.integrations.writeOnly")}
            name="value"
            type="password"
            autoComplete="new-password"
            autoFocus
            isRequired
            value={value}
            onChange={setValue}
          />
          <div className="flex justify-end gap-2">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" isPending={set.isPending} className="btn-primary">
              {t("common.save")}
            </Button>
          </div>
        </Form>
      )}

      {mode === "confirmingClear" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p>{t("settings.integrations.clearConfirm", { name: label })}</p>
          <Button
            className="btn-error btn-sm"
            isPending={clear.isPending}
            onPress={() => clear.mutate({ name })}
          >
            {t("settings.integrations.yesClear")}
          </Button>
          <Button className="btn-ghost btn-sm" autoFocus onPress={close}>
            {t("common.cancel")}
          </Button>
        </div>
      )}

      {error && Object.keys(errors).length === 0 && (
        <p role="alert" className="mt-1 text-error">
          {errorMessage(error)}
        </p>
      )}
    </fieldset>
  );
}
