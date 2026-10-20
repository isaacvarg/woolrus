"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { generatePin, type IssuedBadge, type UserSummary } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

// PIN and badge, from a row of the users table (SPEC-identity "PIN rules", decision 5). Both are
// admin-managed: users can't set their own.

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.users.key() });
}

/** Type a PIN, or Generate one that is shown once for the admin to hand over. */
export function PinDialog({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const invalidate = useInvalidate();
  const [pin, setPin] = useState("");
  const [generated, setGenerated] = useState(false);
  const save = useMutation({
    mutationFn: () => client.users.setPin({ id: user.id, pin }),
    onSuccess: () => {
      toast.success(t("users.pinSaved", { name: user.name }));
      onClose();
    },
    onSettled: invalidate,
  });
  const errors = fieldErrors(save.error);

  return (
    <Dialog
      title={t("users.pinTitle", { name: user.name })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <Form
          validationErrors={errors}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="flex items-end gap-2">
            <div className="grow">
              <TextField
                name="pin"
                label={t("users.newPin")}
                description={t("users.pinHelp")}
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                isRequired
                value={pin}
                onChange={(value) => {
                  setPin(value);
                  setGenerated(false);
                }}
              />
            </div>
            <Button
              className="btn-outline mb-7"
              onPress={() => {
                setPin(generatePin());
                setGenerated(true);
              }}
            >
              {t("users.generate")}
            </Button>
          </div>
          {generated && (
            <p role="status" className="alert alert-info">
              <span>
                {t("users.generatedPin", { name: user.name })}{" "}
                <strong className="font-mono text-xl tracking-widest">{pin}</strong>
              </span>
            </p>
          )}
          {save.error && !errors.pin && (
            <p role="alert" className="text-error">
              {errorMessage(save.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" isPending={save.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}

/**
 * The print view of a just-issued badge: name, QR code (SVG rendered by the server from our own
 * code) and the code as text. The code exists only in this response, so closing loses it.
 */
export function BadgeDialog({ badge, onClose }: { badge: IssuedBadge; onClose: () => void }) {
  const t = useTranslations();
  const { user, code, qrSvg } = badge;

  return (
    <Dialog
      title={t("users.badgeTitle", { name: user.name })}
      isOpen
      isDismissable={false}
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <>
          <p className="alert alert-warning print:hidden">{t("users.badgeOnce")}</p>
          <div className="print-badge flex flex-col items-center gap-2 rounded-box border border-base-300 p-4">
            <p className="text-2xl font-bold">{user.name}</p>
            <div
              role="img"
              aria-label={t("users.badgeQr", { name: user.name })}
              className="w-56 [&>svg]:h-auto [&>svg]:w-full"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG made by `qrcode` on our server from a code we generated; no user input.
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
            <p className="font-mono text-lg tracking-wider">{code}</p>
          </div>
          <div className="modal-action print:hidden">
            <Button className="btn-ghost" onPress={close}>
              {t("users.close")}
            </Button>
            <Button onPress={() => window.print()}>{t("users.print")}</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
