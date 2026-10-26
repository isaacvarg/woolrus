"use client";

import { VOID_REASON_MAX } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  Button as AriaButton,
  Form,
  Group,
  Input,
  Label,
  type ModalOverlayProps,
  NumberField,
  Text,
  ToggleButton,
  ToggleButtonGroup,
} from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextField } from "@/components/ui/fields";

export type VoidDialogLine = { id: string; name: string; activeQuantity: number };
export type VoidDialogInput = { quantity: number; reason: string };

const chips = ["outOfStock", "damaged", "customerRequest", "other"] as const;

/**
 * Asks how many units of a line to void and why (SPEC-exceptions "UI"). It only gathers the
 * answer: the caller runs the mutation in `onConfirm`, and the dialog closes when that resolves
 * (a refusal leaves it open for the caller to toast). Mount it per line, with `isOpen`.
 */
export function VoidDialog({
  line,
  onConfirm,
  isPending = false,
  ...overlay
}: Omit<ModalOverlayProps, "children"> & {
  line: VoidDialogLine;
  onConfirm: (input: VoidDialogInput) => Promise<unknown> | undefined;
  isPending?: boolean;
}) {
  const t = useTranslations();
  // The whole active quantity is the common case: the item is missing or broken.
  const [quantity, setQuantity] = useState(line.activeQuantity);
  const [chip, setChip] = useState<(typeof chips)[number] | null>(null);
  const [reason, setReason] = useState("");

  const pick = (next: (typeof chips)[number]) => {
    setChip(next);
    // "Other" starts a fresh sentence; the others fill in their own words.
    setReason(next === "other" ? "" : t(`voids.reasons.${next}`));
  };

  return (
    <Dialog title={t("voids.title", { name: line.name })} {...overlay}>
      {(close) => (
        <Form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void Promise.resolve(onConfirm({ quantity, reason: reason.trim() })).then(
              close,
              () => {},
            );
          }}
        >
          <NumberField
            value={quantity}
            onChange={(value) => setQuantity(Number.isNaN(value) ? 1 : value)}
            minValue={1}
            maxValue={line.activeQuantity}
            step={1}
            isRequired
            className="fieldset"
          >
            <Label className="fieldset-legend">{t("voids.quantity")}</Label>
            <Group className="join">
              <AriaButton slot="decrement" className="btn btn-lg join-item min-w-16">
                −
              </AriaButton>
              <Input className="input input-lg join-item w-24 text-center tabular-nums" />
              <AriaButton slot="increment" className="btn btn-lg join-item min-w-16">
                +
              </AriaButton>
            </Group>
            <Text slot="description" className="label">
              {t("voids.ofActive", { active: line.activeQuantity })}
            </Text>
          </NumberField>

          <ToggleButtonGroup
            aria-label={t("voids.reasonChips")}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={chip ? [chip] : []}
            onSelectionChange={(keys) => {
              const [key] = [...keys];
              if (key) pick(key as (typeof chips)[number]);
            }}
            className="flex flex-wrap gap-2"
          >
            {chips.map((id) => (
              <ToggleButton
                key={id}
                id={id}
                className={({ isSelected }) =>
                  `btn btn-md ${isSelected ? "btn-primary" : "btn-outline"}`
                }
              >
                {t(`voids.reasons.${id}`)}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>

          <TextField
            label={t("voids.reason")}
            name="reason"
            isRequired
            maxLength={VOID_REASON_MAX}
            // Whitespace alone is no reason; the server trims and refuses it too.
            validate={(value) => (value.trim() ? null : t("errors.field.required"))}
            value={reason}
            onChange={(value) => {
              setReason(value);
              setChip(null);
            }}
          />

          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("order.back")}
            </Button>
            <Button type="submit" className="btn-error" isPending={isPending}>
              {t("voids.confirm")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}
