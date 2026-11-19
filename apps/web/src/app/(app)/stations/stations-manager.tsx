"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  StationSetupCodeIssued,
  StationSetupCodeSummary,
  StationSummary,
} from "@woolrus/contracts";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextField } from "@/components/ui/fields";
import { Menu, MenuItem } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { formatTimeLeft, SetupCode, useTimeLeft } from "./setup-code";

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.stations.key() });
}

export function StationsManager({ canRegister }: { canRegister: boolean }) {
  const t = useTranslations();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const errorMessage = useErrorMessage();
  const stations = useQuery(orpc.stations.list.queryOptions());
  const [registering, setRegistering] = useState(false);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<StationSummary | null>(null);
  const [revoking, setRevoking] = useState<StationSummary | null>(null);
  const columns = 5;

  return (
    <div className="space-y-4">
      {canRegister && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button className="btn-outline" onPress={() => setRegistering(true)}>
            {t("stations.register")}
          </Button>
          <Button onPress={() => setAdding(true)}>{t("stations.addStation")}</Button>
        </div>
      )}
      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table">
          <thead>
            <tr>
              <th>{t("stations.name")}</th>
              <th>{t("stations.currentUser")}</th>
              <th>{t("stations.lastSeen")}</th>
              <th>{t("stations.status")}</th>
              <th>
                <span className="sr-only">{t("stations.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {stations.isPending && (
              <tr>
                <td colSpan={columns}>{t("common.loading")}</td>
              </tr>
            )}
            {stations.error && (
              <tr>
                <td colSpan={columns} className="text-error">
                  {errorMessage(stations.error)}
                </td>
              </tr>
            )}
            {stations.data?.length === 0 && (
              <tr>
                <td colSpan={columns}>{t("stations.none")}</td>
              </tr>
            )}
            {stations.data?.map((station) => (
              <tr key={station.id} className={station.active ? "" : "opacity-60"}>
                <td className="font-medium">{station.name}</td>
                <td>{station.currentUserName ?? t("stations.nobody")}</td>
                <td>
                  {station.lastSeenAt
                    ? format.relativeTime(station.lastSeenAt, now)
                    : t("stations.never")}
                </td>
                <td>
                  <span
                    className={`badge badge-sm ${station.active ? "badge-success" : "badge-ghost"}`}
                  >
                    {station.active ? t("stations.active") : t("stations.revoked")}
                  </span>
                </td>
                <td className="text-right">
                  {station.active && (
                    <Menu label={t("stations.actionsFor", { name: station.name })} trigger="⋯">
                      <MenuItem onAction={() => setRenaming(station)}>
                        {t("stations.rename")}
                      </MenuItem>
                      <MenuItem danger onAction={() => setRevoking(station)}>
                        {t("stations.revoke")}
                      </MenuItem>
                    </Menu>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <OpenSetupCodes />
      {registering && <RegisterDialog onClose={() => setRegistering(false)} />}
      {adding && <AddStationDialog onClose={() => setAdding(false)} />}
      {renaming && <RenameDialog station={renaming} onClose={() => setRenaming(null)} />}
      {revoking && <RevokeDialog station={revoking} onClose={() => setRevoking(null)} />}
    </div>
  );
}

/** The response sets the station cookie and ends this session, so the page leaves for /station. */
function RegisterDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const [name, setName] = useState("");
  const register = useMutation({
    mutationFn: () => client.stations.register({ name }),
    // A full load: this device has no personal session any more.
    onSuccess: () => window.location.assign("/station"),
  });
  const errors = fieldErrors(register.error);

  return (
    <Dialog title={t("stations.registerTitle")} isOpen onOpenChange={(open) => !open && onClose()}>
      {(close) => (
        <Form
          validationErrors={errors}
          onSubmit={(event) => {
            event.preventDefault();
            register.mutate();
          }}
        >
          <p className="mb-2">{t("stations.registerBody")}</p>
          <TextField
            name="name"
            label={t("stations.name")}
            isRequired
            autoFocus
            maxLength={40}
            value={name}
            onChange={setName}
          />
          {register.error && !errors.name && (
            <p role="alert" className="text-error">
              {errorMessage(register.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" isPending={register.isPending || register.isSuccess}>
              {t("stations.registerSubmit")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}

/**
 * Add station (SPEC-identity A3): name it, then show the one-time setup code and its QR for the
 * tablet. The code exists only in this response, so closing the dialog loses it. Once a code has
 * expired, **Get a new code** issues another for the same name.
 */
function AddStationDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const invalidate = useInvalidate();
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<StationSetupCodeIssued | null>(null);
  const issue = useMutation({
    mutationFn: () => client.stations.setupCodes.issue({ name }),
    onSuccess: setIssued,
    onSettled: invalidate,
  });
  const errors = fieldErrors(issue.error);
  const close = () => {
    invalidate();
    onClose();
  };

  return (
    <Dialog
      title={
        issued ? t("stations.setupCodeTitle", { name: issued.name }) : t("stations.addStationTitle")
      }
      isOpen
      isDismissable={!issued}
      onOpenChange={(open) => !open && close()}
    >
      {(closeDialog) =>
        issued ? (
          <SetupCode
            key={issued.id}
            issued={issued}
            onDone={closeDialog}
            onRenew={() => issue.mutate()}
            renewing={issue.isPending}
            renewError={issue.error ? errorMessage(issue.error) : null}
          />
        ) : (
          <Form
            validationErrors={errors}
            onSubmit={(event) => {
              event.preventDefault();
              issue.mutate();
            }}
          >
            <p className="mb-2">{t("stations.addStationBody")}</p>
            <TextField
              name="name"
              label={t("stations.name")}
              isRequired
              autoFocus
              maxLength={40}
              value={name}
              onChange={setName}
            />
            {issue.error && !errors.name && (
              <p role="alert" className="text-error">
                {errorMessage(issue.error)}
              </p>
            )}
            <div className="modal-action">
              <Button className="btn-ghost" onPress={closeDialog}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" isPending={issue.isPending}>
                {t("stations.addStationSubmit")}
              </Button>
            </div>
          </Form>
        )
      }
    </Dialog>
  );
}

/** Codes issued but not yet used, cancelled or expired (SPEC-identity A3), each with Cancel. */
function OpenSetupCodes() {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const codes = useQuery(orpc.stations.setupCodes.list.queryOptions());
  if (codes.error) {
    return (
      <p role="alert" className="text-error">
        {errorMessage(codes.error)}
      </p>
    );
  }
  if (!codes.data?.length) return null;

  return (
    <section aria-labelledby="open-setup-codes" className="space-y-2">
      <h2 id="open-setup-codes" className="text-xl font-semibold">
        {t("stations.openCodes")}
      </h2>
      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table">
          <thead>
            <tr>
              <th>{t("stations.name")}</th>
              <th>{t("stations.timeLeft")}</th>
              <th>{t("stations.issuedBy")}</th>
              <th>
                <span className="sr-only">{t("stations.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {codes.data.map((code) => (
              <OpenSetupCodeRow key={code.id} code={code} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OpenSetupCodeRow({ code }: { code: StationSetupCodeSummary }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const invalidate = useInvalidate();
  const timeLeft = useTimeLeft(code.expiresAt);
  const cancel = useMutation({
    mutationFn: () => client.stations.setupCodes.cancel({ id: code.id }),
    onSuccess: () => toast.success(t("stations.codeCancelled", { name: code.name })),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: invalidate,
  });
  // Expired while the page was open: it's no longer open, so it leaves the list.
  if (timeLeft === 0) return null;

  return (
    <tr>
      <td className="font-medium">{code.name}</td>
      <td className="tabular-nums">{formatTimeLeft(timeLeft)}</td>
      <td>{code.issuedByName}</td>
      <td className="text-right">
        <Button
          className="btn-ghost btn-sm"
          aria-label={t("stations.cancelCodeFor", { name: code.name })}
          isPending={cancel.isPending}
          onPress={() => cancel.mutate()}
        >
          {t("stations.cancelCode")}
        </Button>
      </td>
    </tr>
  );
}

function RenameDialog({ station, onClose }: { station: StationSummary; onClose: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const invalidate = useInvalidate();
  const [name, setName] = useState(station.name);
  const rename = useMutation({
    mutationFn: () => client.stations.rename({ id: station.id, name }),
    onSuccess: () => {
      toast.success(t("stations.renamed"));
      onClose();
    },
    onSettled: invalidate,
  });
  const errors = fieldErrors(rename.error);

  return (
    <Dialog
      title={t("stations.renameTitle", { name: station.name })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <Form
          validationErrors={errors}
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          <TextField
            name="name"
            label={t("stations.name")}
            isRequired
            autoFocus
            maxLength={40}
            value={name}
            onChange={setName}
          />
          {rename.error && !errors.name && (
            <p role="alert" className="text-error">
              {errorMessage(rename.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" isPending={rename.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}

function RevokeDialog({ station, onClose }: { station: StationSummary; onClose: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const invalidate = useInvalidate();
  const revoke = useMutation({
    mutationFn: () => client.stations.revoke({ id: station.id }),
    onSuccess: () => {
      toast.success(t("stations.revokedToast", { name: station.name }));
      onClose();
    },
    onSettled: invalidate,
  });

  return (
    <Dialog
      title={t("stations.revokeTitle", { name: station.name })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <>
          <p>{t("stations.revokeBody")}</p>
          {revoke.error && (
            <p role="alert" className="text-error">
              {errorMessage(revoke.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button
              className="btn-error"
              isPending={revoke.isPending}
              onPress={() => revoke.mutate()}
            >
              {t("stations.revoke")}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
