"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { NoteVisibility } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Button, Switch, TextAreaField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

export const NOTE_MAX_LENGTH = 4000;

/**
 * Internal unless the author may write to the customer (`note.customer`); everyone else never sees
 * the switch, and the server refuses it from them anyway (FR-NOTE-08).
 */
export function VisibilitySwitch({
  value,
  onChange,
}: {
  value: NoteVisibility;
  onChange: (value: NoteVisibility) => void;
}) {
  const t = useTranslations();
  return (
    <div>
      <Switch
        isSelected={value === "CUSTOMER"}
        onChange={(selected) => onChange(selected ? "CUSTOMER" : "INTERNAL")}
      >
        {t("notes.customerVisible")}
      </Switch>
      <p className="text-sm opacity-70">{t("notes.customerVisibleHint")}</p>
    </div>
  );
}

/** Writes a note on the order. */
export function NoteComposer({
  orderId,
  canWriteCustomer,
}: {
  orderId: string;
  canWriteCustomer: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [visibility, setVisibility] = useState<NoteVisibility>("INTERNAL");
  // One key per draft: a retry after a dropped response returns the note instead of adding twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const create = useMutation({
    mutationFn: () => client.notes.create({ idempotencyKey, orderId, content, visibility }),
    onSuccess: () => {
      setContent("");
      setVisibility("INTERNAL");
      setIdempotencyKey(crypto.randomUUID());
      toast.success(t("notes.added"));
    },
    onError: (error) => {
      if (Object.keys(fieldErrors(error)).length === 0) toast.error(errorMessage(error));
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: orpc.notes.list.key({ input: { orderId } }) }),
  });

  return (
    <Form
      className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm"
      validationErrors={create.error ? fieldErrors(create.error) : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <TextAreaField
        label={t("notes.newNote")}
        name="content"
        isRequired
        maxLength={NOTE_MAX_LENGTH}
        validate={(value) => (value.trim() ? null : t("errors.notes.empty"))}
        value={content}
        onChange={setContent}
      />
      {canWriteCustomer && <VisibilitySwitch value={visibility} onChange={setVisibility} />}
      <Button type="submit" className="btn-primary btn-lg" isPending={create.isPending}>
        {t("notes.add")}
      </Button>
    </Form>
  );
}
