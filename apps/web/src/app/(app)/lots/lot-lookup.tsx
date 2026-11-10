"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { LotStatusBadge } from "@/components/lots/lot-list";
import { Button, TextField } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

// Lot lookup (SPEC-lumexia "Reads and UI"): one field for a typed lot number or a scanned lot QR
// code, every package item holding it, and the same rows as CSV.

export function LotLookup() {
  const t = useTranslations("lotLookup");
  const tc = useTranslations("common");
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const [draft, setDraft] = useState("");
  const [code, setCode] = useState("");
  const result = useQuery({
    ...orpc.lumexia.lookupLot.queryOptions({ input: { code } }),
    enabled: code !== "",
  });

  return (
    <div className="space-y-4">
      <Form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setCode(draft.trim());
        }}
      >
        <div className="min-w-64 grow">
          <TextField
            label={t("code")}
            name="code"
            isRequired
            maxLength={100}
            // A scanner types into the focused field and presses Enter.
            autoFocus
            autoComplete="off"
            value={draft}
            onChange={setDraft}
          />
        </div>
        <Button type="submit" className="btn-primary mb-1 min-h-12">
          {t("search")}
        </Button>
        {code && result.data && result.data.rows.length > 0 && (
          <a
            className="btn btn-outline mb-1 min-h-12"
            href={`/api/lots/export.csv?${new URLSearchParams({ code })}`}
            download
          >
            {t("downloadCsv")}
          </a>
        )}
      </Form>

      {code && result.isPending && <p>{tc("loading")}</p>}
      {result.error && (
        <p role="alert" className="alert alert-error">
          {errorMessage(result.error)}
        </p>
      )}
      {code && result.data && (
        <div className="space-y-2">
          <p role="status" data-testid="lot-lookup-count">
            {result.data.rows.length === 0
              ? t("empty", { code })
              : t("count", { count: result.data.rows.length, code })}
          </p>
          {result.data.rows.length > 0 && (
            <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
              <table className="table" data-testid="lot-lookup-results">
                <thead>
                  <tr>
                    <th>{t("columns.order")}</th>
                    <th>{t("columns.customer")}</th>
                    <th>{t("columns.package")}</th>
                    <th>{t("columns.product")}</th>
                    <th>{t("columns.lot")}</th>
                    <th className="text-end">{t("columns.quantity")}</th>
                    <th>{t("columns.status")}</th>
                    <th>{t("columns.shipped")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.rows.map((row) => (
                    <tr key={row.id} data-testid="lot-lookup-row">
                      <td>
                        <Link className="link" href={`/orders/${row.orderId}`}>
                          #{row.orderNumber}
                        </Link>
                      </td>
                      <td>{row.customerName}</td>
                      <td className="tabular-nums">{row.packageNumber}</td>
                      <td>{row.productName}</td>
                      <td className="font-mono">{row.lotNumber ?? row.lumexiaLotId}</td>
                      <td className="text-end tabular-nums">{row.quantity}</td>
                      <td>
                        <LotStatusBadge status={row.status} />
                      </td>
                      <td>
                        {row.shippedAt
                          ? format.dateTime(row.shippedAt, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })
                          : t("notShipped")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
