"use client";

import { useQuery } from "@tanstack/react-query";
import type { AppErrorData, LotDto, PackageItemView } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { useLotText } from "@/components/lots/lot-status";
import { Dialog } from "@/components/ui/dialog";
import { Button, NumberField } from "@/components/ui/fields";
import { orpc } from "@/lib/orpc";

// The pack screen's lot dialogs (SPEC-lumexia "Reads and UI"): a chip's count and removal,
// **Which line?** for a lot scan that fits more than one box line, and the lot picker behind
// **Lot needed** for when there's no scanner to hand.

export type LineCandidate = NonNullable<AppErrorData["candidates"]>[number];

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
              {/* Always enabled: NumberField commits its value on blur or Enter, so while the
                  packer is still typing `quantity` holds the old count. An unchanged save is a
                  no-op on the server. */}
              <Button type="submit" className="btn-primary" isPending={isPending}>
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

/**
 * Tapping **Lot needed**: the line's Lumexia lots, newest first. Choosing one does what scanning
 * its printed number would; scanning still works, and is the way in when Lumexia can't list them.
 */
export function LotPickerDialog({
  packageId,
  packageNumber,
  item,
  isPending,
  onChoose,
  onClose,
}: {
  packageId: string;
  packageNumber: number;
  item: PackageItemView;
  isPending: boolean;
  onChoose: (choice: { lotNumber: string; packageItemId: string }) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const choices = useQuery(
    orpc.packing.lotChoices.queryOptions({
      input: { packageId, orderItemId: item.orderItemId },
    }),
  );
  const data = choices.data;
  const why =
    data?.status === "notLinked"
      ? "pack.lotPickNotLinked"
      : data?.status === "unconfigured"
        ? "pack.lotPickUnconfigured"
        : data?.status === "unavailable" || choices.isError
          ? "pack.lotPickUnavailable"
          : data?.status === "ok" && data.lots.length === 0
            ? "pack.lotPickNone"
            : null;

  return (
    <Dialog
      title={t("pack.lotPickTitle", { name: item.name })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <div className="space-y-4" data-testid="lot-picker">
          <p>{t("pack.lotPickIntro", { count: item.quantity, number: packageNumber })}</p>
          {choices.isPending ? (
            <p className="flex items-center gap-2" role="status">
              <span className="loading loading-spinner loading-sm" aria-hidden />
              {t("pack.lotPickLoading")}
            </p>
          ) : why ? (
            <p className="alert alert-warning" role="status">
              {t(why)}
            </p>
          ) : (
            <>
              <p className="text-sm font-semibold">{t("pack.lotPickNewest")}</p>
              <ul
                className="grid max-h-[50vh] gap-2 overflow-y-auto"
                aria-label={t("pack.lotPickNewest")}
              >
                {data?.lots.map((lot) => {
                  const date = format.dateTime(lot.createdAt, { dateStyle: "medium" });
                  return (
                    <li key={lot.id}>
                      <Button
                        className="btn-outline btn-lg h-auto min-h-16 w-full justify-between py-2 text-start"
                        aria-label={t("pack.lotPickOption", { lot: lot.lotNumber, date })}
                        isDisabled={isPending}
                        onPress={() =>
                          data &&
                          onChoose({ lotNumber: lot.lotNumber, packageItemId: data.packageItemId })
                        }
                      >
                        <span className="font-mono tabular-nums">{lot.lotNumber}</span>
                        <span className="text-sm font-normal">{date}</span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
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
