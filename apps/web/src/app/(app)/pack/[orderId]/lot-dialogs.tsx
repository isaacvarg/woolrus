"use client";

import type { AppErrorData, LotDto, PackageItemView } from "@woolrus/contracts";
import { lotLabel } from "@woolrus/core/lot-codes";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, NumberField } from "@/components/ui/fields";

// The pack screen's lot dialogs (SPEC-lumexia "Reads and UI"): a chip's count and removal, and
// **Which line?** for a lot scan that fits more than one box line.

export type LineCandidate = NonNullable<AppErrorData["candidates"]>[number];

/** What a chip calls a lot: its number without the reference code, or "QR lot" until resolved. */
export function useLotText() {
  const t = useTranslations();
  return (lot: Pick<LotDto, "lotNumber">) =>
    lot.lotNumber ? lotLabel(lot.lotNumber) : t("pack.lotUnresolved");
}

/** A tapped lot chip: change its count (the default lot gives or takes the rest) or remove it. */
export function LotDialog({
  item,
  lot,
  isPending,
  onSetQuantity,
  onRemove,
  onClose,
}: {
  item: PackageItemView;
  lot: LotDto;
  isPending: boolean;
  onSetQuantity: (quantity: number) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const lotText = useLotText();
  const [quantity, setQuantity] = useState(lot.quantity);
  const defaultLot = item.lots.find((l) => l.isDefault);
  // The default keeps at least 1; the default's own count is what the others leave.
  const max = lot.isDefault ? lot.quantity : lot.quantity + (defaultLot?.quantity ?? 1) - 1;

  return (
    <Dialog
      title={t("pack.lotDialogTitle", { lot: lotText(lot) })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <div className="space-y-4" data-testid="lot-dialog">
          <p>{t("pack.lotDialogItem", { name: item.name, count: item.quantity })}</p>
          {lot.isDefault && item.lots.length > 1 ? (
            <p className="text-sm">{t("pack.lotDefaultHint")}</p>
          ) : null}
          {!lot.isDefault && (
            <Form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                onSetQuantity(quantity);
              }}
            >
              <NumberField
                label={t("pack.lotCount")}
                description={t("pack.lotCountHint")}
                minValue={1}
                maxValue={max}
                step={1}
                isRequired
                value={quantity}
                onChange={(value) => setQuantity(Number.isNaN(value) ? lot.quantity : value)}
              />
              <Button
                type="submit"
                className="btn-primary"
                isPending={isPending}
                isDisabled={quantity === lot.quantity}
              >
                {t("pack.lotSave")}
              </Button>
            </Form>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("order.back")}
            </Button>
            <Button className="btn-error btn-outline" isPending={isPending} onPress={onRemove}>
              {t("pack.lotRemove")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** **Which line?**: the box lines a scanned lot could go on; choosing one retries the scan on it. */
export function WhichLineDialog({
  packageNumber,
  candidates,
  isPending,
  onChoose,
  onClose,
}: {
  packageNumber: number;
  candidates: LineCandidate[];
  isPending: boolean;
  onChoose: (packageItemId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  return (
    <Dialog title={t("pack.whichLine")} isOpen onOpenChange={(open) => !open && onClose()}>
      {(close) => (
        <div className="space-y-4">
          <p>{t("pack.whichLineIntro", { number: packageNumber })}</p>
          <ul className="grid gap-2">
            {candidates.map((c) => (
              <li key={c.packageItemId}>
                <Button
                  className="btn-outline btn-lg h-auto min-h-16 w-full justify-start py-2 text-start"
                  isDisabled={isPending}
                  onPress={() => onChoose(c.packageItemId)}
                >
                  {t("pack.whichLineOption", { name: c.name, count: c.quantity })}
                </Button>
              </li>
            ))}
          </ul>
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("order.back")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
