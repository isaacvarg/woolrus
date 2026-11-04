"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LabAddress, LabGroupRef } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { ShipTo } from "@/components/shipping/order-shipping";
import { Dialog } from "@/components/ui/dialog";
import { Button, Checkbox, TextAreaField, TextField } from "@/components/ui/fields";
import { errorData, useErrorMessage, useFieldErrors } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

export const addressFields = [
  "name",
  "company",
  "phone",
  "email",
  "address1",
  "address2",
  "city",
  "state",
  "postalCode",
  "country",
] as const;
export type AddressField = (typeof addressFields)[number];
export const requiredAddressFields = new Set<AddressField>([
  "name",
  "address1",
  "city",
  "postalCode",
  "country",
]);

/**
 * Adds a test address, or edits `address`. Saving a new one keeps the dialog open on the check's
 * result (typed vs. corrected). Once runs have quoted it, the address fields are read-only.
 */
export function AddressDialog({
  address,
  groups,
  onSaved,
  onDuplicated,
  onClose,
}: {
  address: LabAddress | null;
  /** Active address groups; an archived group the address is already in is added below. */
  groups: LabGroupRef[];
  onSaved: (address: LabAddress) => void;
  onDuplicated: (copy: LabAddress) => void;
  onClose: () => void;
}) {
  const t = useTranslations("rateLab.addresses");
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const locked = address?.locked ?? false;
  const [title, setTitle] = useState(address?.title ?? "");
  const [description, setDescription] = useState(address?.description ?? "");
  const [form, setForm] = useState<Record<AddressField, string>>(() => {
    const original = address?.original;
    return Object.fromEntries(
      addressFields.map((f) => [f, original?.[f] ?? (f === "country" ? "US" : "")]),
    ) as Record<AddressField, string>;
  });
  const [groupIds, setGroupIds] = useState(new Set(address?.groups.map((g) => g.id) ?? []));
  // One key per dialog: a retried submit can't create two addresses.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const choices = [
    ...groups,
    ...(address?.groups.filter((g) => !groups.some((active) => active.id === g.id)) ?? []),
  ];

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.rateLab.key() });
  const save = useMutation({
    mutationFn: () => {
      const shared = { title, description, groupIds: [...groupIds] };
      if (address) {
        return orpc.rateLab.updateAddress.call({
          id: address.id,
          ...shared,
          ...(locked ? {} : { address: form }),
        });
      }
      return orpc.rateLab.createAddress.call({ idempotencyKey, ...shared, address: form });
    },
    onSuccess: async (saved) => {
      await refresh();
      if (address) onClose();
      else onSaved(saved);
    },
  });
  const recheck = useMutation(orpc.rateLab.recheckAddress.mutationOptions({ onSuccess: refresh }));
  const duplicate = useMutation(
    orpc.rateLab.duplicateAddress.mutationOptions({
      onSuccess: async (copy) => {
        await refresh();
        onDuplicated(copy);
      },
    }),
  );
  // The re-checked address is shown at once; the list refetch catches up behind it.
  const shown = recheck.data ?? address;
  const recheckRefused = errorData(recheck.error)?.messageKey === "errors.rateLab.recheckChanged";

  return (
    <Dialog
      title={address ? t("edit") : t("add")}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <Form
          className="max-h-[70vh] space-y-2 overflow-y-auto"
          validationErrors={fieldErrors(save.error)}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          {shown && (
            <section aria-label={t("checkResult")} className="space-y-2">
              <ShipTo
                shipTo={{
                  status: shown.checkStatus,
                  address: shown.address,
                  original: shown.original,
                  messages: shown.checkMessages,
                  checkedAt: shown.checkedAt,
                }}
                actions={
                  <Button
                    className="btn-ghost btn-sm"
                    isPending={recheck.isPending}
                    onPress={() => recheck.mutate({ id: shown.id })}
                  >
                    {t("recheck")}
                  </Button>
                }
              />
              {recheck.error && (
                <div role="alert" className="flex flex-wrap items-center gap-2 text-error">
                  <span>{errorMessage(recheck.error)}</span>
                  {recheckRefused && (
                    <Button
                      className="btn-sm"
                      isPending={duplicate.isPending}
                      onPress={() =>
                        duplicate.mutate({ idempotencyKey: crypto.randomUUID(), id: shown.id })
                      }
                    >
                      {t("duplicate")}
                    </Button>
                  )}
                </div>
              )}
            </section>
          )}
          <TextField
            label={t("titleField")}
            name="title"
            isRequired
            maxLength={80}
            value={title}
            onChange={setTitle}
          />
          <TextAreaField
            label={t("description")}
            name="description"
            rows={2}
            maxLength={500}
            value={description}
            onChange={setDescription}
          />
          {locked && (
            <p role="note" className="text-sm" data-testid="lab-address-locked">
              {t("lockedReason")}
            </p>
          )}
          <fieldset className="grid grid-cols-2 gap-x-2">
            <legend className="fieldset-legend">{t("addressLegend")}</legend>
            {addressFields.map((field) => (
              <TextField
                key={field}
                label={t(`fields.${field}`)}
                name={`address.${field}`}
                type={field === "email" ? "email" : "text"}
                isRequired={requiredAddressFields.has(field)}
                isDisabled={locked}
                value={form[field]}
                onChange={(value) => setForm({ ...form, [field]: value })}
              />
            ))}
          </fieldset>
          <fieldset>
            <legend className="fieldset-legend">{t("groupsLegend")}</legend>
            {choices.length === 0 && <p className="text-sm opacity-70">{t("noGroups")}</p>}
            <div className="flex flex-wrap gap-x-4">
              {choices.map((group) => (
                <Checkbox
                  key={group.id}
                  isSelected={groupIds.has(group.id)}
                  onChange={(on) => {
                    const next = new Set(groupIds);
                    if (on) next.add(group.id);
                    else next.delete(group.id);
                    setGroupIds(next);
                  }}
                >
                  {group.name}
                </Checkbox>
              ))}
            </div>
          </fieldset>
          {save.error && (
            <p role="alert" className="text-error">
              {errorMessage(save.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {address ? t("close") : t("cancel")}
            </Button>
            <Button type="submit" isPending={save.isPending}>
              {t("save")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}
