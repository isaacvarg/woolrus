"use client";

import type { Box, PackageBoxInput } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, NumberField } from "@/components/ui/fields";

// The box picker (SPEC-packing "UI"): the active boxes, then a custom size. Used to add a package
// and to change a package's box.

const dimensions = (t: ReturnType<typeof useTranslations>, box: Box) =>
  t("pack.dimensions", { length: box.lengthIn, width: box.widthIn, height: box.heightIn });

export function BoxDialog({
  title,
  boxes,
  isPending,
  onChoose,
  onClose,
}: {
  title: string;
  boxes: Box[];
  isPending: boolean;
  onChoose: (box: PackageBoxInput) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const [size, setSize] = useState({ lengthIn: 0, widthIn: 0, heightIn: 0 });
  const set = (key: keyof typeof size) => (value: number) =>
    setSize((s) => ({ ...s, [key]: Number.isNaN(value) ? 0 : value }));

  return (
    <Dialog title={title} isOpen onOpenChange={(open) => !open && onClose()}>
      {(close) => (
        // Many boxes and the custom form can outgrow a tablet in landscape: scroll inside.
        <div className="max-h-[70vh] space-y-4 overflow-y-auto">
          {boxes.length === 0 && <p>{t("pack.noBoxes")}</p>}
          <ul className="grid gap-2">
            {boxes.map((box) => (
              <li key={box.id}>
                <Button
                  className="btn-outline btn-lg h-auto min-h-16 w-full justify-start py-2 text-start"
                  isDisabled={isPending}
                  onPress={() => onChoose({ boxId: box.id })}
                >
                  <span>
                    <span className="block font-bold">{box.name}</span>
                    <span className="block text-sm font-normal">{dimensions(t, box)}</span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
          <Form
            className="space-y-2 border-t border-base-300 pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              onChoose(size);
            }}
          >
            <h3 className="font-bold">{t("pack.custom")}</h3>
            <p className="text-sm">{t("pack.customHint")}</p>
            <div className="grid grid-cols-3 gap-2">
              <NumberField
                label={t("pack.length")}
                minValue={0.01}
                maxValue={999}
                step={0.01}
                isRequired
                value={size.lengthIn || Number.NaN}
                onChange={set("lengthIn")}
              />
              <NumberField
                label={t("pack.width")}
                minValue={0.01}
                maxValue={999}
                step={0.01}
                isRequired
                value={size.widthIn || Number.NaN}
                onChange={set("widthIn")}
              />
              <NumberField
                label={t("pack.height")}
                minValue={0.01}
                maxValue={999}
                step={0.01}
                isRequired
                value={size.heightIn || Number.NaN}
                onChange={set("heightIn")}
              />
            </div>
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("order.back")}
              </Button>
              <Button type="submit" className="btn-primary" isPending={isPending}>
                {t("pack.useCustom")}
              </Button>
            </div>
          </Form>
        </div>
      )}
    </Dialog>
  );
}
