"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Box } from "@woolrus/contracts";
import { formatWeight } from "@woolrus/core/format";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button, Checkbox } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { BoxDialog } from "./box-dialog";

const size = (a: number | null, b: number | null, c: number | null) =>
  a === null || b === null || c === null ? "—" : `${a} × ${b} × ${c}`;

export function BoxesManager({ canManage }: { canManage: boolean }) {
  const t = useTranslations("boxes");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const boxes = useQuery(
    orpc.boxes.list.queryOptions({ input: { includeArchived: showArchived } }),
  );
  const settings = useQuery(orpc.settings.public.queryOptions());
  // Until settings load, use the schema default so the table isn't held back.
  const weightDisplay = settings.data?.weightDisplay ?? "LB_OZ";
  // `false`: closed; `null`: adding; a box: editing it.
  const [editing, setEditing] = useState<Box | null | false>(false);
  const [deleting, setDeleting] = useState<Box | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.boxes.key() });
  const archive = useMutation(orpc.boxes.archive.mutationOptions({ onSuccess: refresh }));
  const restore = useMutation(orpc.boxes.restore.mutationOptions({ onSuccess: refresh }));
  const remove = useMutation(
    orpc.boxes.delete.mutationOptions({
      onSuccess: async () => {
        setDeleting(null);
        await refresh();
      },
    }),
  );
  const rowError = archive.error ?? restore.error;
  const weight = (oz: number | null) =>
    oz === null ? "—" : formatWeight(oz, weightDisplay, locale);
  const columns = canManage ? 8 : 7;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Checkbox isSelected={showArchived} onChange={setShowArchived}>
          {t("showArchived")}
        </Checkbox>
        {canManage && <Button onPress={() => setEditing(null)}>{t("add")}</Button>}
      </div>
      {rowError && (
        <p role="alert" className="text-error">
          {errorMessage(rowError)}
        </p>
      )}
      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table">
          <thead>
            <tr>
              <th>{t("name")}</th>
              <th>{t("dimensions")}</th>
              <th>{t("outerDimensions")}</th>
              <th>{t("tare")}</th>
              <th>{t("maxWeightColumn")}</th>
              <th>{t("status")}</th>
              {canManage && (
                <th>
                  <span className="sr-only">{t("actions")}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {boxes.isPending && (
              <tr>
                <td colSpan={columns}>{t("loading")}</td>
              </tr>
            )}
            {boxes.error && (
              <tr>
                <td colSpan={columns} className="text-error">
                  {errorMessage(boxes.error)}
                </td>
              </tr>
            )}
            {boxes.data?.length === 0 && (
              <tr>
                <td colSpan={columns}>{t("empty")}</td>
              </tr>
            )}
            {boxes.data?.map((box) => (
              <tr key={box.id} data-testid="box-row" className={box.archived ? "opacity-60" : ""}>
                <td>{box.name}</td>
                <td>{size(box.lengthIn, box.widthIn, box.heightIn)}</td>
                <td>{size(box.outerLengthIn, box.outerWidthIn, box.outerHeightIn)}</td>
                <td>{weight(box.tareWeightOz)}</td>
                <td>{weight(box.maxWeightOz)}</td>
                <td className="space-x-1">
                  {box.inUse && <span className="badge badge-info">{t("inUse")}</span>}
                  {box.archived && <span className="badge badge-ghost">{t("archived")}</span>}
                </td>
                {canManage && (
                  <td className="whitespace-nowrap text-right">
                    <Button className="btn-ghost btn-sm" onPress={() => setEditing(box)}>
                      {t("edit")}
                    </Button>
                    {box.archived ? (
                      <Button
                        className="btn-ghost btn-sm"
                        isPending={restore.isPending && restore.variables?.id === box.id}
                        onPress={() => restore.mutate({ id: box.id })}
                      >
                        {t("restore")}
                      </Button>
                    ) : (
                      <Button
                        className="btn-ghost btn-sm"
                        isPending={archive.isPending && archive.variables?.id === box.id}
                        onPress={() => archive.mutate({ id: box.id })}
                      >
                        {t("archive")}
                      </Button>
                    )}
                    {!box.inUse && (
                      <Button
                        className="btn-ghost btn-sm text-error"
                        onPress={() => setDeleting(box)}
                      >
                        {t("delete")}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing !== false && (
        <BoxDialog
          key={editing?.id ?? "new"}
          box={editing}
          weightDisplay={weightDisplay}
          onClose={() => setEditing(false)}
        />
      )}
      {deleting && (
        <Dialog
          title={t("deleteTitle", { name: deleting.name })}
          isOpen
          onOpenChange={(open) => !open && setDeleting(null)}
        >
          {(close) => (
            <div className="space-y-2">
              <p>{t("deleteHint")}</p>
              {remove.error && (
                <p role="alert" className="text-error">
                  {errorMessage(remove.error)}
                </p>
              )}
              <div className="modal-action">
                <Button className="btn-ghost" onPress={close}>
                  {t("cancel")}
                </Button>
                <Button
                  className="btn-error"
                  isPending={remove.isPending}
                  onPress={() => remove.mutate({ id: deleting.id })}
                >
                  {t("delete")}
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
