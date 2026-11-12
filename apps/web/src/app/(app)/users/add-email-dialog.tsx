"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UserSummary } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { randomUUID } from "@/lib/uuid";

/**
 * Add email, for a station-only user (SPEC-identity amendment 1): they become a regular user with
 * the same id, roles, PIN and badge. The address is asked for twice: a typo would send their
 * sign-in email to someone else.
 */
export function AddEmailDialog({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  // One key per dialog: a retried submit (flaky Wi-Fi) can't send the email twice.
  const [idempotencyKey] = useState(() => randomUUID());
  const add = useMutation({
    mutationFn: () => client.users.addEmail({ idempotencyKey, id: user.id, email }),
    onSuccess: (updated) => {
      toast.success(t("users.emailAdded", { name: updated.name, email: updated.email ?? "" }));
      onClose();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.users.key() }),
  });
  const errors: Record<string, string> = {
    ...fieldErrors(add.error),
    ...(mismatch ? { confirm: t("users.emailMismatch") } : {}),
  };

  return (
    <Dialog
      title={t("users.addEmailTitle", { name: user.name })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <Form
          validationErrors={errors}
          onSubmit={(event) => {
            event.preventDefault();
            const matches = email.trim().toLowerCase() === confirm.trim().toLowerCase();
            setMismatch(!matches);
            if (matches) add.mutate();
          }}
        >
          <p>{t("users.addEmailHelp", { name: user.name })}</p>
          <TextField
            name="email"
            label={t("users.email")}
            type="email"
            isRequired
            autoFocus
            value={email}
            onChange={setEmail}
          />
          <TextField
            name="confirm"
            label={t("users.confirmEmail")}
            type="email"
            isRequired
            value={confirm}
            onChange={(value) => {
              setConfirm(value);
              setMismatch(false);
            }}
          />
          {add.error && !errors.email && (
            <p role="alert" className="text-error">
              {errorMessage(add.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" isPending={add.isPending}>
              {t("users.addEmail")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}
