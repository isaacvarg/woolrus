"use client";

import type {
  Box,
  BoxGroup,
  BoxPickerColumns,
  BoxSuggestion,
  PackageBoxInput,
  WeightDisplay,
} from "@woolrus/contracts";
import { formatWeight } from "@woolrus/core/format";
import { arrangeBoxPicker } from "@woolrus/core/picker";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, NumberField } from "@/components/ui/fields";

// The box picker (SPEC-packing "UI", A2): the suggested box full width on top, then the boxes in
// their groups in the admin's order (`arrangeBoxPicker`), each in the packer's 1 or 2 columns, then
// a custom size. Used to add a package and to change a package's box.

const dimensions = (t: ReturnType<typeof useTranslations>, box: Box) =>
  t("pack.dimensions", { length: box.lengthIn, width: box.widthIn, height: box.heightIn });

export function BoxDialog({
  title,
  boxes,
  boxGroups,
  suggestion,
  weightDisplay,
  columns,
  isPending,
  onChoose,
  onClose,
}: {
  title: string;
  boxes: Box[];
  boxGroups: BoxGroup[];
  suggestion: BoxSuggestion;
  weightDisplay: WeightDisplay;
  /** The user's `boxPickerColumns`; two drop to one below 480 px so a phone stays readable. */
  columns: BoxPickerColumns;
  isPending: boolean;
  onChoose: (box: PackageBoxInput) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const headingId = useId();
  // The suggested box leads, once; nothing is chosen until the packer taps one.
  const { suggested, sections } = arrangeBoxPicker(boxes, boxGroups, suggestion);
  // With no group shown, the ungrouped boxes need no "Other boxes" heading: today's picker.
  const headed = sections.some((section) => section.group !== null);
  const gridClass = `grid gap-2 ${columns === 2 ? "grid-cols-1 min-[480px]:grid-cols-2" : ""}`;
  const boxButton = (box: Box, className: string, extra?: ReactNode) => (
    <Button
      className={`btn-lg h-auto min-h-16 w-full justify-start py-2 text-start ${className}`}
      isDisabled={isPending}
      onPress={() => onChoose({ boxId: box.id })}
    >
      <span>
        <span className="block font-bold">{box.name}</span>
        <span className="block text-sm font-normal">{dimensions(t, box)}</span>
        {extra}
      </span>
    </Button>
  );
  const [size, setSize] = useState({ lengthIn: 0, widthIn: 0, heightIn: 0 });
  const set = (key: keyof typeof size) => (value: number) =>
    setSize((s) => ({ ...s, [key]: Number.isNaN(value) ? 0 : value }));

  return (
    <Dialog title={title} isOpen onOpenChange={(open) => !open && onClose()}>
      {(close) => (
        // Many boxes and the custom form can outgrow a tablet in landscape: scroll inside.
        <div className="max-h-[70vh] space-y-4 overflow-y-auto">
          {boxes.length === 0 && <p>{t("pack.noBoxes")}</p>}
          {suggestion.kind === "split" && (
            <p className="alert alert-info" data-testid="box-suggestion">
              {t("pack.suggestSplit")}
            </p>
          )}
          {suggestion.kind === "unknown" && (
            <p className="alert alert-info" data-testid="box-suggestion">
              {t("pack.suggestUnknown", { names: suggestion.missing.join(", ") })}
            </p>
          )}
          {suggested &&
            suggestion.kind === "box" &&
            // Outlined in the primary colour and labelled, so it isn't marked by colour alone.
            boxButton(
              suggested,
              "btn-outline border-2 border-primary",
              <span className="block text-sm font-normal" data-testid="box-suggestion">
                <span className="badge badge-primary me-2">{t("pack.suggested")}</span>
                {t("pack.suggestFits", {
                  weight: formatWeight(suggestion.estimatedWeightOz, weightDisplay, locale),
                })}
              </span>,
            )}
          {sections.map((section, i) => {
            const grid = (
              <ul className={gridClass} data-testid="box-grid">
                {section.boxes.map((box) => (
                  <li key={box.id}>{boxButton(box, "btn-outline")}</li>
                ))}
              </ul>
            );
            if (!headed) return <div key="other">{grid}</div>;
            // Announced as a group by its heading; the divider separates it from what's above.
            const id = `${headingId}-${i}`;
            return (
              // A fieldset is a group without the role attribute; its heading labels it.
              <fieldset
                key={section.group?.id ?? "other"}
                aria-labelledby={id}
                className="space-y-2 border-t border-base-300 pt-4"
              >
                <h3 id={id} className="font-bold">
                  {section.group?.name ?? t("pack.otherBoxes")}
                </h3>
                {grid}
              </fieldset>
            );
          })}
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
