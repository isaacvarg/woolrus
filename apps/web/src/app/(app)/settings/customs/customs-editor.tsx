"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { CustomsFilter, CustomsProduct } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Button, TextField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

const filters: CustomsFilter[] = ["all", "missing", "international"];

/** Settings → Customs (FR-SHIP-13): products with their HS code, origin and description, edited in place. */
export function CustomsEditor() {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const [filter, setFilter] = useState<CustomsFilter>("all");
  const [editing, setEditing] = useState<string | null>(null);

  const products = useInfiniteQuery(
    orpc.shipping.customsProducts.infiniteOptions({
      input: (cursor: string | undefined) => ({ filter, cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const rows = products.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label={t("customs.filter")} className="join">
        {filters.map((value) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control; the label is the button text.
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={filter === value}
            className={`btn join-item ${filter === value ? "btn-primary" : ""}`}
            onClick={() => {
              setFilter(value);
              setEditing(null);
            }}
          >
            {t(`customs.filters.${value}`)}
          </button>
        ))}
      </div>

      {products.isPending ? (
        <p>{t("common.loading")}</p>
      ) : products.error ? (
        <p role="alert" className="text-error">
          {errorMessage(products.error)}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
          <table className="table" aria-label={t("customs.title")}>
            <thead>
              <tr>
                <th>{t("customs.product")}</th>
                <th>{t("customs.hsCode")}</th>
                <th>{t("customs.countryOfOrigin")}</th>
                <th>{t("customs.description")}</th>
                <th>
                  <span className="sr-only">{t("customs.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5}>{t("customs.empty")}</td>
                </tr>
              )}
              {rows.map((product) =>
                editing === product.id ? (
                  <EditRow key={product.id} product={product} onDone={() => setEditing(null)} />
                ) : (
                  <ViewRow
                    key={product.id}
                    product={product}
                    onEdit={() => setEditing(product.id)}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      {products.hasNextPage && (
        <Button
          className="btn-outline"
          isPending={products.isFetchingNextPage}
          onPress={() => products.fetchNextPage()}
        >
          {t("customs.loadMore")}
        </Button>
      )}
    </div>
  );
}

function ViewRow({ product, onEdit }: { product: CustomsProduct; onEdit: () => void }) {
  const t = useTranslations();
  const none = <span className="text-base-content/50">{t("customs.none")}</span>;
  return (
    <tr>
      <td className="break-words">
        <p className="font-medium">{product.name}</p>
        <p className="text-sm text-base-content/70">{product.sku}</p>
        <p className="mt-1 flex flex-wrap gap-1">
          {product.missing && (
            <span className="badge badge-warning">{t("customs.missingBadge")}</span>
          )}
          {product.onInternationalOrder && (
            <span className="badge badge-info">{t("customs.international")}</span>
          )}
        </p>
      </td>
      <td>{product.hsCode ?? none}</td>
      <td>{product.countryOfOrigin ?? none}</td>
      <td className="break-words">{product.customsDescription ?? none}</td>
      <td>
        <Button
          className="btn-sm btn-outline"
          aria-label={t("customs.editProduct", { name: product.name })}
          onPress={onEdit}
        >
          {t("customs.edit")}
        </Button>
      </td>
    </tr>
  );
}

/** Blank clears the field; the server validates and normalizes the rest. */
const orNull = (value: string) => (value.trim() === "" ? null : value);

function EditRow({ product, onDone }: { product: CustomsProduct; onDone: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: (form: FormData) =>
      client.shipping.updateProductCustoms({
        productId: product.id,
        hsCode: orNull(String(form.get("hsCode") ?? "")),
        countryOfOrigin: orNull(String(form.get("countryOfOrigin") ?? "")),
        customsDescription: orNull(String(form.get("customsDescription") ?? "")),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.shipping.key() });
      toast.success(t("customs.saved", { name: product.name }));
      onDone();
    },
    onError: (error) => {
      if (Object.keys(fieldErrors(error)).length === 0) toast.error(errorMessage(error));
    },
  });

  return (
    <tr>
      <td colSpan={5}>
        <Form
          className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-start"
          validationErrors={save.error ? fieldErrors(save.error) : {}}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(new FormData(event.currentTarget));
          }}
        >
          <p className="font-medium md:col-span-4">{product.name}</p>
          <TextField
            name="hsCode"
            label={t("customs.hsCode")}
            description={t("customs.hsCodeHint")}
            defaultValue={product.hsCode ?? ""}
          />
          <TextField
            name="countryOfOrigin"
            label={t("customs.countryOfOrigin")}
            description={t("customs.countryHint")}
            defaultValue={product.countryOfOrigin ?? ""}
          />
          <TextField
            name="customsDescription"
            label={t("customs.description")}
            description={t("customs.descriptionHint")}
            defaultValue={product.customsDescription ?? ""}
            maxLength={100}
          />
          <div className="flex gap-2 md:mt-8">
            <Button type="submit" isPending={save.isPending}>
              {t("customs.save")}
            </Button>
            <Button className="btn-outline" onPress={onDone}>
              {t("customs.cancel")}
            </Button>
          </div>
        </Form>
      </td>
    </tr>
  );
}
