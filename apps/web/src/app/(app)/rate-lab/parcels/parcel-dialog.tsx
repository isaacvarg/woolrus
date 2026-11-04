"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LabGroupRef, LabParcel, LabParcelProduct, WeightDisplay } from "@woolrus/contracts";
import { formatWeight } from "@woolrus/core/format";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { WeightInput } from "@/app/(app)/boxes/weight-input";
import { Dialog } from "@/components/ui/dialog";
import {
  Button,
  Checkbox,
  NumberField,
  Radio,
  RadioGroup,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/ui/fields";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

type Item = { product: LabParcelProduct; quantity: number };
type Side = "lengthIn" | "widthIn" | "heightIn";
const sides: { key: Side; label: "length" | "width" | "height" }[] = [
  { key: "lengthIn", label: "length" },
  { key: "widthIn", label: "width" },
  { key: "heightIn", label: "height" },
];

/**
 * Adds a test parcel, or edits `parcel`. The size comes from a box (its inner size is copied) or
 * is typed. Once runs have quoted it, size, weight and contents are read-only.
 */
export function ParcelDialog({
  parcel,
  groups,
  weightDisplay,
  onClose,
}: {
  parcel: LabParcel | null;
  /** Active parcel groups; an archived group the parcel is already in is added below. */
  groups: LabGroupRef[];
  weightDisplay: WeightDisplay;
  onClose: () => void;
}) {
  const t = useTranslations("rateLab.parcels");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const locked = parcel?.locked ?? false;
  const [title, setTitle] = useState(parcel?.title ?? "");
  const [description, setDescription] = useState(parcel?.description ?? "");
  const [source, setSource] = useState<"box" | "typed">(parcel && !parcel.box ? "typed" : "box");
  const [boxId, setBoxId] = useState<string | null>(parcel?.box?.id ?? null);
  const [typed, setTyped] = useState<Record<Side, number>>({
    lengthIn: parcel && !parcel.box ? parcel.lengthIn : Number.NaN,
    widthIn: parcel && !parcel.box ? parcel.widthIn : Number.NaN,
    heightIn: parcel && !parcel.box ? parcel.heightIn : Number.NaN,
  });
  const [weightOz, setWeightOz] = useState<number | null>(parcel?.weightOz ?? null);
  const [items, setItems] = useState<Item[]>(parcel?.items ?? []);
  const [productSearch, setProductSearch] = useState("");
  const [groupIds, setGroupIds] = useState(new Set(parcel?.groups.map((g) => g.id) ?? []));
  // One key per dialog: a retried submit can't create two parcels.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const choices = [
    ...groups,
    ...(parcel?.groups.filter((g) => !groups.some((active) => active.id === g.id)) ?? []),
  ];

  const boxes = useQuery(orpc.boxes.list.queryOptions({ input: { includeArchived: false } }));
  const products = useQuery({
    ...orpc.rateLab.parcelProducts.queryOptions({ input: { search: productSearch } }),
    enabled: !locked && productSearch.trim() !== "",
  });
  // The parcel's own box keeps the size it copied, even if archived or edited since.
  const boxOptions = [
    ...(boxes.data ?? []).map((b) => ({ id: b.id, label: b.name })),
    ...(parcel?.box && !boxes.data?.some((b) => b.id === parcel.box?.id)
      ? [{ id: parcel.box.id, label: parcel.box.name }]
      : []),
  ];
  const boxSize =
    parcel?.box && boxId === parcel.box.id
      ? parcel
      : (boxes.data?.find((b) => b.id === boxId) ?? null);

  const save = useMutation({
    mutationFn: () => {
      const shared = { title, description, groupIds: [...groupIds] };
      const physical = {
        size: source === "box" ? { boxId } : typed,
        weightOz: weightOz ?? Number.NaN,
        items: items.map(({ product, quantity }) => ({ productId: product.id, quantity })),
      };
      if (parcel) {
        return orpc.rateLab.updateParcel.call({
          id: parcel.id,
          ...shared,
          ...(locked ? {} : physical),
        });
      }
      return orpc.rateLab.createParcel.call({ idempotencyKey, ...shared, ...physical });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.rateLab.key() });
      onClose();
    },
  });

  return (
    <Dialog
      title={parcel ? t("edit") : t("add")}
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
            <p role="note" className="text-sm" data-testid="lab-parcel-locked">
              {t("lockedReason")}
            </p>
          )}
          <fieldset>
            <legend className="fieldset-legend">{t("sizeLegend")}</legend>
            <RadioGroup
              label={t("sizeSource")}
              value={source}
              onChange={(value) => setSource(value as "box" | "typed")}
              isDisabled={locked}
            >
              <Radio value="box">{t("fromBox")}</Radio>
              <Radio value="typed">{t("typed")}</Radio>
            </RadioGroup>
            {source === "box" ? (
              <>
                <SelectField
                  label={t("box")}
                  name="size.boxId"
                  isRequired
                  isDisabled={locked}
                  selectedKey={boxId}
                  onSelectionChange={(key) => setBoxId(key === null ? null : String(key))}
                  options={boxOptions}
                />
                {boxSize && (
                  <p className="text-sm opacity-70" data-testid="lab-parcel-box-size">
                    {t("boxSize", {
                      length: boxSize.lengthIn,
                      width: boxSize.widthIn,
                      height: boxSize.heightIn,
                    })}
                  </p>
                )}
              </>
            ) : (
              <div className="grid grid-cols-3 gap-x-2">
                {sides.map(({ key, label }) => (
                  <NumberField
                    key={key}
                    label={t(label)}
                    name={`size.${key}`}
                    isRequired
                    isDisabled={locked}
                    minValue={0.01}
                    value={typed[key]}
                    onChange={(value) => setTyped({ ...typed, [key]: value })}
                  />
                ))}
              </div>
            )}
          </fieldset>
          {locked ? (
            <TextField
              label={t("weightField")}
              isDisabled
              value={formatWeight(parcel?.weightOz ?? 0, weightDisplay, locale)}
            />
          ) : (
            <WeightInput
              label={t("weightField")}
              valueOz={weightOz}
              weightDisplay={weightDisplay}
              onChange={setWeightOz}
            />
          )}
          <fieldset className="space-y-1">
            <legend className="fieldset-legend">{t("contentsLegend")}</legend>
            <p className="text-sm opacity-70">{t("contentsHint")}</p>
            {items.map((item) => (
              <div key={item.product.id} className="flex items-end gap-2">
                <span className="grow pb-3">
                  {item.product.name}
                  {item.product.sku && <span className="opacity-70"> · {item.product.sku}</span>}
                </span>
                <div className="w-28">
                  <NumberField
                    label={t("quantity", { name: item.product.name })}
                    isRequired
                    isDisabled={locked}
                    minValue={1}
                    maxValue={999}
                    step={1}
                    value={item.quantity}
                    onChange={(quantity) =>
                      setItems(
                        items.map((i) =>
                          i.product.id === item.product.id ? { ...i, quantity } : i,
                        ),
                      )
                    }
                  />
                </div>
                {!locked && (
                  <Button
                    className="btn-ghost btn-sm mb-2"
                    aria-label={t("removeItem", { name: item.product.name })}
                    onPress={() => setItems(items.filter((i) => i.product.id !== item.product.id))}
                  >
                    ✕
                  </Button>
                )}
              </div>
            ))}
            {!locked && (
              <>
                <TextField
                  label={t("findProduct")}
                  type="search"
                  value={productSearch}
                  onChange={setProductSearch}
                />
                {products.data?.length === 0 && (
                  <p className="text-sm opacity-70">{t("noProducts")}</p>
                )}
                <div className="flex flex-wrap gap-1">
                  {products.data
                    ?.filter((p) => !items.some((i) => i.product.id === p.id))
                    .map((product) => (
                      <Button
                        key={product.id}
                        className="btn-outline btn-sm"
                        aria-label={t("addItem", { name: product.name })}
                        onPress={() => {
                          setItems([...items, { product, quantity: 1 }]);
                          setProductSearch("");
                        }}
                      >
                        + {product.name}
                      </Button>
                    ))}
                </div>
              </>
            )}
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
              {t("cancel")}
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
