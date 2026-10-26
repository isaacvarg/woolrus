"use client";

import { useMutation } from "@tanstack/react-query";
import type { PickLine, PickLineResult } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, NumberField, TextAreaField, TextField } from "@/components/ui/fields";
import { Menu, MenuItem } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client } from "@/lib/orpc";

// A card's menu and its Out of Stock / Substituted dialogs (SPEC-picking "UI", FR-PICK-04). Both
// write a line note, so each open dialog carries one idempotency key: a retried submit can't note twice.

type Props = {
  line: PickLine;
  disabled: boolean;
  /** Shares the card writes' scope, so these land in order with the taps around them. */
  scope: string;
  onResult: (result: PickLineResult) => void;
};

/** `quantity` adds a "how many picked" item, for screens without a stepper (the batch chips). */
export function LineMenu({
  quantity = false,
  onVoid,
  onReport,
  ...props
}: Props & { quantity?: boolean; onVoid?: () => void; onReport?: () => void }) {
  const t = useTranslations();
  const [open, setOpen] = useState<"quantity" | "outOfStock" | "substitute" | null>(null);
  const close = () => setOpen(null);
  if (props.disabled) return null;
  return (
    <>
      <Menu
        label={t("pick.lineActions", { name: props.line.name })}
        trigger="⋯"
        triggerClassName="btn-ghost btn-lg text-2xl"
      >
        {quantity && (
          <MenuItem onAction={() => setOpen("quantity")}>{t("pick.quantity.action")}</MenuItem>
        )}
        {/* Out of Stock means fewer than needed were found, so a single unit can still be short. */}
        <MenuItem onAction={() => setOpen("outOfStock")}>{t("pick.outOfStock.action")}</MenuItem>
        <MenuItem onAction={() => setOpen("substitute")}>{t("pick.substitute.action")}</MenuItem>
        {onVoid && <MenuItem onAction={onVoid}>{t("voids.button")}</MenuItem>}
        {onReport && <MenuItem onAction={onReport}>{t("issues.button")}</MenuItem>}
      </Menu>
      {open === "quantity" && <QuantityDialog {...props} onClose={close} />}
      {open === "outOfStock" && <OutOfStockDialog {...props} onClose={close} />}
      {open === "substitute" && <SubstituteDialog {...props} onClose={close} />}
    </>
  );
}

function useLineWrite<I extends { idempotencyKey: string }>(
  { scope, onResult }: Props,
  onClose: () => void,
  call: (input: I) => Promise<PickLineResult>,
  done: string,
) {
  const errorMessage = useErrorMessage();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  return useMutation({
    scope: { id: scope },
    mutationFn: (input: Omit<I, "idempotencyKey">) => call({ ...input, idempotencyKey } as I),
    onSuccess: (result) => {
      onResult(result);
      toast.success(done);
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
}

/** Sets how many units are picked so far; 0 puts the line back to not picked. Absolute, so no key. */
function QuantityDialog({ line, scope, onResult, onClose }: Props & { onClose: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const [picked, setPicked] = useState(line.pickedQuantity);
  const save = useMutation({
    scope: { id: scope },
    mutationFn: (quantity: number) =>
      quantity === 0
        ? client.picking.unpickLine({ itemId: line.id })
        : client.picking.pickLine({ itemId: line.id, quantity }),
    onSuccess: (result) => {
      onResult(result);
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog
      title={t("pick.quantity.title", { name: line.name })}
      isOpen
      onOpenChange={(o) => !o && onClose()}
    >
      {(close) => (
        <Form
          className="space-y-2"
          validationErrors={fieldErrors(save.error)}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(picked);
          }}
        >
          <NumberField
            name="quantity"
            label={t("pick.quantity.picked")}
            description={t("pick.quantity.hint", { quantity: line.quantity })}
            minValue={0}
            maxValue={line.quantity}
            step={1}
            isRequired
            value={picked}
            onChange={(v) => setPicked(Number.isNaN(v) ? 0 : v)}
            autoFocus
          />
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("order.back")}
            </Button>
            <Button type="submit" className="btn-primary" isPending={save.isPending}>
              {t("pick.quantity.submit")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}

function OutOfStockDialog(props: Props & { onClose: () => void }) {
  const { line, onClose } = props;
  const t = useTranslations();
  const fieldErrors = useFieldErrors();
  const [found, setFound] = useState(Math.min(line.pickedQuantity, line.quantity - 1));
  const [note, setNote] = useState("");
  const save = useLineWrite(
    props,
    onClose,
    client.picking.markOutOfStock,
    t("pick.outOfStock.done", { name: line.name }),
  );

  return (
    <Dialog
      title={t("pick.outOfStock.title", { name: line.name })}
      isOpen
      onOpenChange={(o) => !o && onClose()}
    >
      {(close) => (
        <Form
          className="space-y-2"
          validationErrors={fieldErrors(save.error)}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({ itemId: line.id, foundQuantity: found, note: note.trim() });
          }}
        >
          <NumberField
            name="foundQuantity"
            label={t("pick.outOfStock.found")}
            description={t("pick.outOfStock.foundHint", { quantity: line.quantity })}
            minValue={0}
            maxValue={line.quantity - 1}
            step={1}
            isRequired
            value={found}
            onChange={(v) => setFound(Number.isNaN(v) ? 0 : v)}
          />
          <TextAreaField
            name="note"
            label={t("pick.outOfStock.note")}
            rows={3}
            isRequired
            maxLength={500}
            validate={(value) => (value.trim() ? null : t("errors.field.required"))}
            value={note}
            onChange={setNote}
            autoFocus
          />
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("order.back")}
            </Button>
            <Button type="submit" className="btn-error" isPending={save.isPending}>
              {t("pick.outOfStock.submit")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}

function SubstituteDialog(props: Props & { onClose: () => void }) {
  const { line, onClose } = props;
  const t = useTranslations();
  const fieldErrors = useFieldErrors();
  const [instead, setInstead] = useState("");
  const [note, setNote] = useState("");
  const save = useLineWrite(
    props,
    onClose,
    client.picking.substitute,
    t("pick.substitute.done", { name: line.name }),
  );

  return (
    <Dialog
      title={t("pick.substitute.title", { name: line.name })}
      isOpen
      onOpenChange={(o) => !o && onClose()}
    >
      {(close) => (
        <Form
          className="space-y-2"
          validationErrors={fieldErrors(save.error)}
          onSubmit={(event) => {
            event.preventDefault();
            const extra = note.trim();
            save.mutate({
              itemId: line.id,
              substitute: instead.trim(),
              ...(extra ? { note: extra } : {}),
            });
          }}
        >
          <TextField
            name="substitute"
            label={t("pick.substitute.instead")}
            description={t("pick.substitute.insteadHint")}
            isRequired
            maxLength={200}
            validate={(value) => (value.trim() ? null : t("errors.field.required"))}
            value={instead}
            onChange={setInstead}
            autoFocus
          />
          <TextAreaField
            name="note"
            label={t("pick.substitute.note")}
            rows={3}
            maxLength={500}
            value={note}
            onChange={setNote}
          />
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("order.back")}
            </Button>
            <Button type="submit" className="btn-primary" isPending={save.isPending}>
              {t("pick.substitute.submit")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}
