"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import type { LinkSuggestion, LumexiaItemDto, LumexiaProductRow } from "@woolrus/contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  Button as AriaButton,
  ComboBox,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  ToggleButton,
  ToggleButtonGroup,
} from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, Checkbox } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

// Lumexia items (SPEC-lumexia "Reads and UI"): every product with its Lumexia link, item type and
// whether it needs a lot; Match by SKU, a per-row item search, Unlink and the three-way Lot setting.

const filters = ["all", "linked", "unlinked", "needsLot"] as const;
type Filter = (typeof filters)[number];

const keep: Record<Filter, (row: LumexiaProductRow) => boolean> = {
  all: () => true,
  linked: (row) => row.link !== null,
  unlinked: (row) => row.link === null,
  needsLot: (row) => row.needsLot,
};

/** `linkProducts` takes at most this many links per call. */
const LINK_BATCH = 200;
const SEARCH_DEBOUNCE_MS = 250;

const features = tableFeatures({});
const column = createColumnHelper<typeof features, LumexiaProductRow>();
const columns = column.columns([
  column.display({ id: "product" }),
  column.display({ id: "item" }),
  column.display({ id: "itemType" }),
  column.display({ id: "needsLot" }),
  column.display({ id: "lot" }),
  column.display({ id: "actions" }),
]);
type ColumnId = "product" | "item" | "itemType" | "needsLot" | "lot" | "actions";

export function LumexiaItems() {
  const t = useTranslations("lumexiaItems");
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [suggestions, setSuggestions] = useState<LinkSuggestion[] | null>(null);

  const products = useQuery(orpc.lumexia.products.queryOptions());
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: orpc.lumexia.products.queryKey() });
  const suggest = useMutation(
    orpc.lumexia.suggestLinks.mutationOptions({
      onSuccess: setSuggestions,
      onError: (error) => toast.error(errorMessage(error)),
    }),
  );

  const data = (products.data?.products ?? []).filter(keep[filter]);
  const table = useTable({ features, columns, data, getRowId: (row) => row.id });
  const rows = table.getRowModel().rows;

  if (products.isPending) return <span className="loading loading-spinner" />;
  if (products.error)
    return (
      <p role="alert" className="alert alert-error">
        {errorMessage(products.error)}
      </p>
    );
  if (!products.data.configured)
    return (
      <div role="alert" className="alert alert-warning">
        <span>{t("notConfigured")}</span>
        <Link href="/settings" className="link">
          {t("openSettings")}
        </Link>
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <ToggleButtonGroup
          aria-label={t("filter")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[filter]}
          onSelectionChange={(keys) => {
            const [next] = [...keys];
            if (next) setFilter(next as Filter);
          }}
          className="flex flex-wrap gap-2"
        >
          {filters.map((f) => (
            <ToggleButton
              key={f}
              id={f}
              className={({ isSelected }) =>
                `btn btn-sm ${isSelected ? "btn-primary" : "btn-outline"}`
              }
            >
              {t(`filters.${f}`)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Button isPending={suggest.isPending} onPress={() => suggest.mutate({})}>
          {suggest.isPending ? t("matching") : t("matchBySku")}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table text-base">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th key={header.id}>{t(`columns.${header.column.id as ColumnId}`)}</th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length}>{t("noProducts")}</td>
              </tr>
            )}
            {rows.map(({ original: row }) => (
              <ProductRow key={row.id} row={row} onChanged={refresh} />
            ))}
          </tbody>
        </table>
      </div>

      {suggestions && (
        <ReviewDialog
          suggestions={suggestions}
          onClose={() => setSuggestions(null)}
          onLinked={refresh}
        />
      )}
    </div>
  );
}

function ProductRow({ row, onChanged }: { row: LumexiaProductRow; onChanged: () => void }) {
  const t = useTranslations("lumexiaItems");
  const errorMessage = useErrorMessage();
  const onError = (error: unknown) => toast.error(errorMessage(error));
  const unlink = useMutation(
    orpc.lumexia.unlinkProduct.mutationOptions({
      onSuccess: () => {
        toast.success(t("unlinked", { product: row.name }));
        onChanged();
      },
      onError,
    }),
  );
  const override = useMutation(
    orpc.lumexia.setLotOverride.mutationOptions({ onSuccess: onChanged, onError }),
  );
  const lotKey = row.lotOverride === null ? "rules" : row.lotOverride ? "always" : "never";

  return (
    <tr className="align-top">
      <td>
        <div className="font-semibold">{row.name}</div>
        <div className="font-mono text-sm text-base-content/70">{row.sku ?? t("noSku")}</div>
      </td>
      <td>
        {row.link ? (
          <>
            <span className="font-mono">{row.link.referenceCode ?? row.link.itemId}</span>
            {row.link.notFound && (
              <span className="badge badge-warning badge-sm ms-2">{t("notFound")}</span>
            )}
          </>
        ) : (
          <span className="text-base-content/70">{t("notLinked")}</span>
        )}
      </td>
      <td>{row.link && (row.link.itemTypeName ?? t("unknownType"))}</td>
      <td>
        {row.needsLot ? t("yes") : t("no")}
        {row.lotOverride !== null && (
          <span className="badge badge-ghost badge-sm ms-2">{t("override")}</span>
        )}
      </td>
      <td className="min-w-44">
        {row.link && (
          <LotSelect
            label={t("lotSetting", { product: row.name })}
            value={lotKey}
            isDisabled={override.isPending}
            onChange={(key) =>
              override.mutate({
                productId: row.id,
                lotOverride: key === "rules" ? null : key === "always",
              })
            }
          />
        )}
      </td>
      <td className="min-w-64 space-y-2">
        <ItemSearch row={row} onLinked={onChanged} />
        {row.link && (
          <Button
            className="btn-ghost btn-sm"
            isPending={unlink.isPending}
            onPress={() => unlink.mutate({ productId: row.id })}
          >
            {t("unlink")}
          </Button>
        )}
      </td>
    </tr>
  );
}

type LotKey = "rules" | "always" | "never";

/** The three-way Lot setting, labelled for screen readers only: the column header says it. */
function LotSelect({
  label,
  value,
  isDisabled,
  onChange,
}: {
  label: string;
  value: LotKey;
  isDisabled: boolean;
  onChange: (key: LotKey) => void;
}) {
  const t = useTranslations("lumexiaItems.lotOptions");
  const options: LotKey[] = ["rules", "always", "never"];
  return (
    <Select
      value={value}
      isDisabled={isDisabled}
      onChange={(key) => {
        if (key !== null && key !== value) onChange(key as LotKey);
      }}
    >
      <Label className="sr-only">{label}</Label>
      <AriaButton className="select select-sm w-full text-start">
        <SelectValue className="truncate" />
      </AriaButton>
      <Popover className="rounded-box border border-base-300 bg-base-100 shadow-lg">
        <ListBox className="menu w-(--trigger-width) p-1">
          {options.map((id) => (
            <ListBoxItem
              key={id}
              id={id}
              className="cursor-pointer rounded-field px-3 py-2 outline-none data-focused:bg-base-200 data-selected:font-semibold"
            >
              {t(id)}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

/** A combobox over Lumexia's item search; picking an item links the product to it. */
function ItemSearch({ row, onLinked }: { row: LumexiaProductRow; onLinked: () => void }) {
  const t = useTranslations("lumexiaItems");
  const errorMessage = useErrorMessage();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    ...orpc.lumexia.searchItems.queryOptions({ input: { q } }),
    enabled: q.length > 0,
  });
  const link = useMutation(
    orpc.lumexia.linkProduct.mutationOptions({
      onSuccess: (result) => {
        toast.success(t("linked", { product: row.name, item: result.referenceCode ?? "" }));
        setText("");
        onLinked();
      },
      onError: (error) => toast.error(errorMessage(error)),
    }),
  );
  const items: LumexiaItemDto[] = q ? (results.data ?? []) : [];

  return (
    <ComboBox
      aria-label={t("search", { product: row.name })}
      inputValue={text}
      onInputChange={setText}
      items={items}
      allowsEmptyCollection
      menuTrigger="input"
      isDisabled={link.isPending}
      onSelectionChange={(key) => {
        if (key !== null) link.mutate({ productId: row.id, itemId: String(key) });
      }}
      className="w-full"
    >
      <Input
        className="input input-sm w-full"
        placeholder={t("searchPlaceholder")}
        maxLength={100}
      />
      <Popover className="w-(--trigger-width) rounded-box border border-base-300 bg-base-100 shadow-lg">
        <ListBox
          className="menu w-full p-1"
          renderEmptyState={() => (
            <p className="p-2 text-sm text-base-content/70">
              {results.isFetching
                ? t("searching")
                : results.error
                  ? errorMessage(results.error)
                  : t("noItems")}
            </p>
          )}
        >
          {(item: LumexiaItemDto) => (
            <ListBoxItem
              id={item.id}
              textValue={`${item.referenceCode} ${item.name}`}
              className="cursor-pointer rounded-field px-3 py-2 outline-none data-focused:bg-base-200"
            >
              <span className="font-mono">{item.referenceCode}</span>{" "}
              <span className="text-base-content/70">{item.name}</span>
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}

const MATCH_LABEL = {
  referenceCode: "matchedCode",
  alias: "matchedAlias",
  baseCode: "matchedBase",
} as const;

/** Match by SKU's review: every suggestion ticked; alias matches are flagged for a second look. */
function ReviewDialog({
  suggestions,
  onClose,
  onLinked,
}: {
  suggestions: LinkSuggestion[];
  onClose: () => void;
  onLinked: () => void;
}) {
  const t = useTranslations("lumexiaItems.review");
  const errorMessage = useErrorMessage();
  const [chosen, setChosen] = useState(() => new Set(suggestions.map((s) => s.productId)));
  const link = useMutation(orpc.lumexia.linkProducts.mutationOptions());
  const picked = suggestions.filter((s) => chosen.has(s.productId));

  const confirm = async () => {
    let linked = 0;
    try {
      for (let at = 0; at < picked.length; at += LINK_BATCH) {
        const links = picked
          .slice(at, at + LINK_BATCH)
          .map((s) => ({ productId: s.productId, itemId: s.item.id }));
        linked += (await link.mutateAsync({ links })).linked;
      }
      toast.success(t("done", { count: linked }));
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      if (linked > 0) onLinked();
    }
  };

  return (
    <Dialog
      title={t("title")}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {(close) => (
        <>
          {suggestions.length === 0 ? (
            <p>{t("none")}</p>
          ) : (
            <>
              <p className="text-sm text-base-content/70">{t("intro")}</p>
              <ul className="space-y-1">
                {suggestions.map((s) => (
                  <li key={s.productId}>
                    <Checkbox
                      isSelected={chosen.has(s.productId)}
                      onChange={(on) => {
                        const next = new Set(chosen);
                        if (on) next.add(s.productId);
                        else next.delete(s.productId);
                        setChosen(next);
                      }}
                    >
                      <span>
                        <span className="font-semibold">{s.productName}</span>{" "}
                        <span className="font-mono text-sm">{s.sku}</span> →{" "}
                        <span className="font-mono">{s.item.referenceCode}</span>{" "}
                        <span
                          className={`badge badge-sm ${s.matchedOn === "alias" ? "badge-warning" : "badge-ghost"}`}
                        >
                          {t(MATCH_LABEL[s.matchedOn], { value: s.matchedValue })}
                        </span>
                      </span>
                    </Checkbox>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button className="btn-ghost" onPress={close}>
              {t("cancel")}
            </Button>
            {suggestions.length > 0 && (
              <Button isDisabled={picked.length === 0} isPending={link.isPending} onPress={confirm}>
                {t("confirm", { count: picked.length })}
              </Button>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
