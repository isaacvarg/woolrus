"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ProviderAccount,
  providerConfigFields,
  providerCredentialFields,
  type SetProviderCredentialsInput,
} from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, Switch, TextField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

/** Every provider mutation returns its account: swap it into the list. */
function useApplyAccount() {
  const queryClient = useQueryClient();
  return (account: ProviderAccount) =>
    queryClient.setQueryData(orpc.carriers.providers.queryKey(), (list) =>
      list?.map((p) => (p.provider === account.provider ? account : p)),
    );
}

export function ProvidersSection() {
  const errorMessage = useErrorMessage();
  const providers = useQuery(orpc.carriers.providers.queryOptions());

  if (providers.isPending) return <span className="loading loading-spinner" />;
  if (providers.isError) {
    return (
      <p role="alert" className="alert alert-error">
        {errorMessage(providers.error)}
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {providers.data.map((account) => (
        <ProviderCard key={account.provider} account={account} />
      ))}
    </div>
  );
}

function ProviderCard({ account }: { account: ProviderAccount }) {
  const t = useTranslations();
  const headingId = useId();
  const name = t(`settings.shipping.names.${account.provider}`);
  const configured = Object.values(account.credentials).some((c) => c.configured);

  return (
    <section aria-labelledby={headingId} className="card bg-base-100 shadow-sm">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id={headingId} className="card-title">
            {name}
          </h2>
          {!account.adapterAvailable && (
            <span className="badge badge-ghost">{t("settings.shipping.comingSoon")}</span>
          )}
          <div className="ml-auto">
            <EnableSwitch account={account} name={name} />
          </div>
        </div>
        {!account.adapterAvailable && (
          <p className="text-sm text-base-content/70">
            {t("settings.shipping.comingSoonHint", { name })}
          </p>
        )}
        {providerConfigFields[account.provider].includes("baseUrl") && (
          <BaseUrlForm account={account} configured={configured} />
        )}
        <Credentials account={account} name={name} configured={configured} />
        <TestConnection account={account} />
        <p className="text-sm text-base-content/70">
          {t("settings.shipping.carrierCount", { count: account.carrierCount })}
        </p>
      </div>
    </section>
  );
}

function EnableSwitch({ account, name }: { account: ProviderAccount; name: string }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const applyAccount = useApplyAccount();
  const toggle = useMutation(
    orpc.carriers.setProviderEnabled.mutationOptions({
      onSuccess: (updated) => {
        applyAccount(updated);
        toast.success(
          t(
            updated.enabled ? "settings.shipping.enabledToast" : "settings.shipping.disabledToast",
            {
              name,
            },
          ),
        );
      },
      onError: (error) => toast.error(errorMessage(error)),
    }),
  );

  return (
    <Switch
      isSelected={account.enabled}
      // A provider that's on can always be turned off, even if its adapter left this build.
      isDisabled={toggle.isPending || (!account.enabled && !account.adapterAvailable)}
      onChange={(enabled) => toggle.mutate({ provider: account.provider, enabled })}
    >
      {t("settings.shipping.enable", { name })}
    </Switch>
  );
}

/**
 * Write-only credentials: each field shows only whether it is set. They are saved together (one
 * encrypted blob), so Replace asks for every field again; nothing is pre-filled.
 */
function Credentials({
  account,
  name,
  configured,
}: {
  account: ProviderAccount;
  name: string;
  configured: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const applyAccount = useApplyAccount();
  const labelId = useId();
  const fields = providerCredentialFields(account.provider);
  const [mode, setMode] = useState<"idle" | "editing" | "confirmingClear">("idle");
  const [values, setValues] = useState<Record<string, string>>({});

  const close = () => {
    setValues({});
    setMode("idle");
  };
  const set = useMutation(
    orpc.carriers.setCredentials.mutationOptions({
      onSuccess: (updated) => {
        applyAccount(updated);
        close();
      },
    }),
  );
  const clear = useMutation(
    orpc.carriers.clearCredentials.mutationOptions({
      onSuccess: (updated) => {
        applyAccount(updated);
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
  // Server paths are "credentials.apiKey"; the inputs are named after the field alone.
  const errors = Object.fromEntries(
    Object.entries(fieldErrors(set.error)).map(([path, message]) => [
      path.replace(/^credentials\./, ""),
      message,
    ]),
  );

  return (
    <fieldset aria-labelledby={labelId} className="border-t border-base-200 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span id={labelId} className="font-medium">
          {t("settings.shipping.credentials")}
        </span>
        {mode === "idle" && (
          <div className="ml-auto flex gap-2">
            <Button className="btn-outline btn-sm" onPress={() => open("editing")}>
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
      <ul className="mt-2 space-y-1">
        {fields.map((field) => (
          <li key={field} className="flex items-center gap-2">
            <span>{t(`settings.shipping.fields.${field}` as never)}</span>
            <span
              className={`badge ${account.credentials[field]?.configured ? "badge-success" : "badge-ghost"}`}
            >
              {account.credentials[field]?.configured
                ? t("settings.integrations.set")
                : t("settings.integrations.notSet")}
            </span>
          </li>
        ))}
      </ul>

      {mode === "editing" && (
        <Form
          className="mt-2"
          validationErrors={errors}
          onSubmit={(event) => {
            event.preventDefault();
            set.mutate({
              provider: account.provider,
              credentials: values,
            } as SetProviderCredentialsInput);
          }}
        >
          {fields.map((field, index) => (
            <TextField
              key={field}
              label={t(`settings.shipping.fields.${field}` as never)}
              description={index === 0 ? t("settings.integrations.writeOnly") : undefined}
              name={field}
              type="password"
              autoComplete="new-password"
              autoFocus={index === 0}
              isRequired
              value={values[field] ?? ""}
              onChange={(value) => setValues((current) => ({ ...current, [field]: value }))}
            />
          ))}
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
          <p>{t("settings.shipping.clearConfirm", { name })}</p>
          <Button
            className="btn-error btn-sm"
            isPending={clear.isPending}
            onPress={() => clear.mutate({ provider: account.provider })}
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

/** The last test's result comes from the account, so it survives a reload. */
function TestConnection({ account }: { account: ProviderAccount }) {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const applyAccount = useApplyAccount();
  const test = useMutation(
    orpc.carriers.test.mutationOptions({ onSuccess: ({ account }) => applyAccount(account) }),
  );

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        className="btn-outline"
        isPending={test.isPending}
        onPress={() => test.mutate({ provider: account.provider })}
      >
        {t("settings.shipping.testConnection")}
      </Button>
      <div aria-live="polite" className="basis-full">
        {test.error ? (
          <p className="text-error">{errorMessage(test.error)}</p>
        ) : (
          account.lastCheckedAt && (
            <p className={account.lastErrorKey ? "text-error" : "text-success"}>
              {account.lastErrorKey
                ? t.has(account.lastErrorKey)
                  ? t(account.lastErrorKey as never)
                  : t("errors.internal")
                : t("settings.shipping.testOk")}{" "}
              <span className="text-base-content/70">
                {t("settings.shipping.lastChecked", {
                  at: format.dateTime(account.lastCheckedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                })}
              </span>
            </p>
          )
        )}
      </div>
    </div>
  );
}

const originOf = (url: string | null) => (url && URL.canParse(url) ? new URL(url).origin : null);

/** Bridge Source's API host. Moving it to another server first asks to drop the credentials. */
function BaseUrlForm({ account, configured }: { account: ProviderAccount; configured: boolean }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const applyAccount = useApplyAccount();
  const saved = account.config.baseUrl;
  const [value, setValue] = useState(saved ?? "");
  const [confirming, setConfirming] = useState(false);

  const save = useMutation(
    orpc.carriers.updateConfig.mutationOptions({
      onSuccess: ({ credentialsCleared: _, ...updated }) => {
        setValue(updated.config.baseUrl ?? "");
        setConfirming(false);
        applyAccount(updated);
      },
    }),
  );
  const errors = fieldErrors(save.error);
  const next = value.trim() === "" ? null : value.trim();
  // Mirrors `updateProviderConfig`: an origin change or a removal; a first URL is not a move.
  const moves =
    saved !== null &&
    (next === null || (originOf(next) !== null && originOf(next) !== originOf(saved)));
  const submit = () => {
    if (account.provider === "BRIDGE_SOURCE")
      save.mutate({ provider: "BRIDGE_SOURCE", baseUrl: next });
  };

  return (
    <Form
      className="flex flex-wrap items-end gap-x-4"
      validationErrors={errors}
      onSubmit={(event) => {
        event.preventDefault();
        if (configured && moves) setConfirming(true);
        else submit();
      }}
    >
      <div className="min-w-64 flex-1">
        <TextField
          label={t("settings.shipping.fields.baseUrl")}
          name="baseUrl"
          inputMode="url"
          value={value}
          onChange={(next) => {
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
          ? save.data.credentialsCleared
            ? t("settings.shipping.savedCredentialsCleared")
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
            <p>{t("settings.shipping.urlMoveBody")}</p>
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
