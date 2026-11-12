"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LAB_ONE_OFF_MAX_PARCELS, type LabOneOff, type LabOneOffParcel } from "@woolrus/contracts";
import { formatWeight } from "@woolrus/core/format";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { WeightInput } from "@/app/(app)/boxes/weight-input";
import { ShipTo, useRateErrorText } from "@/components/shipping/order-shipping";
import { Dialog } from "@/components/ui/dialog";
import { Button, Checkbox, TextField } from "@/components/ui/fields";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { money } from "@/lib/money";
import { orpc } from "@/lib/orpc";
import { randomUUID } from "@/lib/uuid";
import { AddressFields, addressForm } from "../address-fields";
import {
  blankSize,
  ParcelSizeFields,
  type SizeSource,
  type TypedSize,
} from "../parcel-size-fields";

// The Quote tab (SPEC-rate-lab "One-off quotes"): a typed address against saved parcels, parcel
// groups and parcels typed here; quotes come back in the same request, a table per parcel.

/** A parcel typed on this screen. `key` keeps each row's inputs its own when one is removed. */
type TypedParcel = {
  key: string;
  source: SizeSource;
  boxId: string | null;
  size: TypedSize;
  weightOz: number | null;
};

const newParcel = (): TypedParcel => ({
  key: randomUUID(),
  source: "box",
  boxId: null,
  size: blankSize(),
  weightOz: null,
});

const toggle = (set: Set<string>, id: string, on: boolean) => {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
};

export function QuoteScreen({ canManage }: { canManage: boolean }) {
  const t = useTranslations("rateLab.quote");
  const tParcel = useTranslations("rateLab.parcels");
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const [address, setAddress] = useState(() => addressForm());
  const [parcelIds, setParcelIds] = useState(new Set<string>());
  const [groupIds, setGroupIds] = useState(new Set<string>());
  const [typed, setTyped] = useState<TypedParcel[]>([]);

  const settings = useQuery(orpc.settings.public.queryOptions());
  const weightDisplay = settings.data?.weightDisplay ?? "LB_OZ";
  const parcels = useQuery(orpc.rateLab.parcels.queryOptions({ input: {} }));
  const groups = useQuery(
    orpc.rateLab.groups.queryOptions({ input: { kind: "PARCEL", includeArchived: false } }),
  );
  const boxes = useQuery(orpc.boxes.list.queryOptions({ input: { includeArchived: false } }));
  const boxOptions = (boxes.data ?? []).map((b) => ({ id: b.id, label: b.name }));

  const quote = useMutation({
    mutationFn: () =>
      orpc.rateLab.quoteOneOff.call({
        address,
        parcelIds: [...parcelIds],
        parcelGroupIds: [...groupIds],
        adHocParcels: typed.map((p) => ({
          size: p.source === "box" ? { boxId: p.boxId } : p.size,
          weightOz: p.weightOz ?? Number.NaN,
        })),
      }),
  });
  const update = (key: string, change: Partial<TypedParcel>) =>
    setTyped(typed.map((p) => (p.key === key ? { ...p, ...change } : p)));

  return (
    <div className="space-y-6">
      <Form
        className="space-y-4 rounded-box bg-base-100 p-4 shadow-sm"
        aria-label={t("form")}
        validationErrors={fieldErrors(quote.error)}
        onSubmit={(event) => {
          event.preventDefault();
          quote.mutate();
        }}
      >
        <AddressFields
          value={address}
          onChange={setAddress}
          className="grid gap-x-2 md:grid-cols-2"
        />

        <fieldset className="space-y-2">
          <legend className="fieldset-legend">{t("savedParcels")}</legend>
          {parcels.data?.length === 0 && <p className="text-sm opacity-70">{t("noParcels")}</p>}
          <div className="flex flex-wrap gap-x-4">
            {parcels.data?.map((parcel) => (
              <Checkbox
                key={parcel.id}
                isSelected={parcelIds.has(parcel.id)}
                onChange={(on) => setParcelIds(toggle(parcelIds, parcel.id, on))}
              >
                {parcel.title}
              </Checkbox>
            ))}
          </div>
        </fieldset>

        {(groups.data?.length ?? 0) > 0 && (
          <fieldset className="space-y-2">
            <legend className="fieldset-legend">{t("parcelGroups")}</legend>
            <div className="flex flex-wrap gap-x-4">
              {groups.data?.map((group) => (
                <Checkbox
                  key={group.id}
                  isSelected={groupIds.has(group.id)}
                  onChange={(on) => setGroupIds(toggle(groupIds, group.id, on))}
                >
                  {group.name}
                </Checkbox>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="space-y-3">
          <legend className="fieldset-legend">{t("typedParcels")}</legend>
          {typed.map((parcel, index) => (
            <div
              key={parcel.key}
              className="space-y-1 rounded-box border border-base-300 p-3"
              data-testid="typed-parcel"
            >
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{t("typedParcel", { number: index + 1 })}</h3>
                <Button
                  className="btn-ghost btn-sm"
                  aria-label={t("removeParcel", { number: index + 1 })}
                  onPress={() => setTyped(typed.filter((p) => p.key !== parcel.key))}
                >
                  ✕
                </Button>
              </div>
              <ParcelSizeFields
                namePrefix={`adHocParcels.${index}.size`}
                source={parcel.source}
                onSourceChange={(source) => update(parcel.key, { source })}
                boxId={parcel.boxId}
                onBoxChange={(boxId) => update(parcel.key, { boxId })}
                boxOptions={boxOptions}
                size={parcel.size}
                onSizeChange={(size) => update(parcel.key, { size })}
              />
              <WeightInput
                label={tParcel("weightField")}
                name={`adHocParcels.${index}.weightOz`}
                isRequired
                valueOz={parcel.weightOz}
                weightDisplay={weightDisplay}
                onChange={(weightOz) => update(parcel.key, { weightOz })}
              />
            </div>
          ))}
          <Button className="btn-outline btn-sm" onPress={() => setTyped([...typed, newParcel()])}>
            {t("addParcel")}
          </Button>
        </fieldset>

        <p className="text-sm opacity-70">{t("parcelLimit", { max: LAB_ONE_OFF_MAX_PARCELS })}</p>
        {quote.error && (
          <p role="alert" className="text-error">
            {errorMessage(quote.error)}
          </p>
        )}
        <Button type="submit" isPending={quote.isPending}>
          {t("getQuotes")}
        </Button>
      </Form>

      {quote.data && <Results key={quote.data.runId} result={quote.data} canManage={canManage} />}
    </div>
  );
}

function Results({ result, canManage }: { result: LabOneOff; canManage: boolean }) {
  const t = useTranslations("rateLab.quote");
  return (
    <section aria-label={t("results")} className="space-y-4" data-testid="one-off-results">
      {result.fake && (
        <p className="alert alert-info" role="note">
          {t("fake")}
        </p>
      )}
      <ShipTo
        shipTo={{
          status: result.check.status,
          address: result.check.address,
          original: result.check.original,
          messages: result.check.messages,
          checkedAt: result.check.checkedAt,
        }}
        actions={
          canManage && (
            <SaveButton
              label={t("saveAddress")}
              dialogTitle={t("saveAddressTitle")}
              save={(title, idempotencyKey) =>
                orpc.rateLab.saveOneOffAddress.call({ idempotencyKey, runId: result.runId, title })
              }
            />
          )
        }
      />
      {result.parcels.map((parcel, index) => (
        <ParcelQuotes
          // biome-ignore lint/suspicious/noArrayIndexKey: one-off answers keep their order.
          key={index}
          parcel={parcel}
          runId={result.runId}
          canManage={canManage}
        />
      ))}
    </section>
  );
}

function ParcelQuotes({
  parcel,
  runId,
  canManage,
}: {
  parcel: LabOneOffParcel;
  runId: string;
  canManage: boolean;
}) {
  const t = useTranslations();
  const tq = useTranslations("rateLab.quote");
  const format = useFormatter();
  const locale = useLocale();
  const errorText = useRateErrorText();
  const settings = useQuery(orpc.settings.public.queryOptions());
  const title = parcel.parcel?.title ?? tq("typedParcel", { number: (parcel.adHocIndex ?? 0) + 1 });
  const adHocIndex = parcel.adHocIndex;

  return (
    <div className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm" data-testid="parcel-quotes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-sm opacity-70">
            {tq("parcelSize", {
              length: parcel.lengthIn,
              width: parcel.widthIn,
              height: parcel.heightIn,
              weight: formatWeight(
                parcel.weightOz,
                settings.data?.weightDisplay ?? "LB_OZ",
                locale,
              ),
            })}
          </p>
        </div>
        {canManage && adHocIndex !== null && (
          <SaveButton
            label={tq("saveParcel")}
            dialogTitle={tq("saveParcelTitle")}
            save={(parcelTitle, idempotencyKey) =>
              orpc.rateLab.saveOneOffParcel.call({
                idempotencyKey,
                runId,
                index: adHocIndex,
                title: parcelTitle,
              })
            }
          />
        )}
      </div>
      {parcel.errors.length > 0 && (
        <ul className="space-y-1" data-testid="rate-errors">
          {parcel.errors.map((error) => (
            <li key={`${error.provider}-${error.messageKey}`} className="alert alert-warning">
              {errorText(error)}
            </li>
          ))}
        </ul>
      )}
      {parcel.quotes.length === 0 ? (
        <p className="text-sm opacity-70">{t("orderShipping.noRates")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table" aria-label={tq("quotesFor", { parcel: title })}>
            <thead>
              <tr>
                <th>{t("orderShipping.columns.provider")}</th>
                <th>{t("orderShipping.columns.carrier")}</th>
                <th>{t("orderShipping.columns.service")}</th>
                <th className="text-end">{t("orderShipping.columns.price")}</th>
                <th>{t("orderShipping.columns.delivery")}</th>
              </tr>
            </thead>
            <tbody>
              {parcel.quotes.map((quote) => (
                <tr key={`${quote.provider}-${quote.carrierName}-${quote.serviceName}`}>
                  <td>{t(`settings.shipping.names.${quote.provider}`)}</td>
                  <td>{quote.carrierName}</td>
                  <td>
                    {quote.serviceName}
                    {quote.cheapest && (
                      <span className="badge badge-success ms-2">{tq("cheapest")}</span>
                    )}
                    {quote.quoteOnly && (
                      <span className="badge badge-outline ms-2">
                        {t("orderShipping.quoteOnly")}
                      </span>
                    )}
                  </td>
                  <td className="text-end tabular-nums">
                    {money(format, quote.amountCents, quote.currency)}
                  </td>
                  <td>
                    {quote.deliveryDays !== null
                      ? t("orderShipping.deliveryDays", { count: quote.deliveryDays })
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** A save button that asks for a title; once saved, it says so in its place. */
function SaveButton({
  label,
  dialogTitle,
  save,
}: {
  label: string;
  dialogTitle: string;
  save: (title: string, idempotencyKey: string) => Promise<{ title: string }>;
}) {
  const t = useTranslations("rateLab.quote");
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  // One key per button: a retried save can't create two items.
  const [idempotencyKey] = useState(() => randomUUID());
  const mutation = useMutation({
    mutationFn: () => save(title, idempotencyKey),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: orpc.rateLab.key() });
    },
  });

  if (mutation.data) {
    return (
      <span className="text-sm text-success" role="status">
        {t("saved", { title: mutation.data.title })}
      </span>
    );
  }
  return (
    <>
      <Button className="btn-outline btn-sm" onPress={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog title={dialogTitle} isOpen={open} onOpenChange={setOpen}>
        {(close) => (
          <Form
            className="space-y-2"
            validationErrors={fieldErrors(mutation.error)}
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate();
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
            <p className="text-sm opacity-70">{t("saveHint")}</p>
            {mutation.error && (
              <p role="alert" className="text-error">
                {errorMessage(mutation.error)}
              </p>
            )}
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("cancel")}
              </Button>
              <Button type="submit" isPending={mutation.isPending}>
                {t("save")}
              </Button>
            </div>
          </Form>
        )}
      </Dialog>
    </>
  );
}
