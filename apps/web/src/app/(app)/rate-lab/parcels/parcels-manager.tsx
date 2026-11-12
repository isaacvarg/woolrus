"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LabParcel } from "@woolrus/contracts";
import { formatWeight } from "@woolrus/core/format";
import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { Button, Checkbox, SelectField, TextField } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { randomUUID } from "@/lib/uuid";
import { GroupsDialog } from "../addresses/groups-dialog";
import { ParcelDialog } from "./parcel-dialog";

const ALL = "all";

export function ParcelsManager({ canManage }: { canManage: boolean }) {
  const t = useTranslations("rateLab.parcels");
  const tGroups = useTranslations("rateLab.groups");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [groupId, setGroupId] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  // Typing renders at once; the list follows the deferred text and keeps its rows meanwhile.
  const deferredSearch = useDeferredValue(search);
  // `false`: closed; `null`: adding; a parcel: editing it.
  const [editing, setEditing] = useState<LabParcel | null | false>(false);
  const [managingGroups, setManagingGroups] = useState(false);

  const settings = useQuery(orpc.settings.public.queryOptions());
  // Until settings load, use the schema default so the table isn't held back.
  const weightDisplay = settings.data?.weightDisplay ?? "LB_OZ";
  const groups = useQuery(
    orpc.rateLab.groups.queryOptions({ input: { kind: "PARCEL", includeArchived: false } }),
  );
  const parcels = useQuery(
    orpc.rateLab.parcels.queryOptions({
      input: {
        includeArchived: showArchived,
        groupIds: groupId === ALL ? [] : [groupId],
        search: deferredSearch,
      },
      placeholderData: keepPreviousData,
    }),
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.rateLab.key() });
  const archive = useMutation(orpc.rateLab.archiveParcel.mutationOptions({ onSuccess: refresh }));
  const unarchive = useMutation(
    orpc.rateLab.unarchiveParcel.mutationOptions({ onSuccess: refresh }),
  );
  const duplicate = useMutation(
    orpc.rateLab.duplicateParcel.mutationOptions({
      onSuccess: async (copy) => {
        await refresh();
        setEditing(copy);
      },
    }),
  );
  const rowError = archive.error ?? unarchive.error ?? duplicate.error;
  const columns = canManage ? 6 : 5;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-56">
          <SelectField
            label={t("group")}
            selectedKey={groupId}
            onSelectionChange={(key) => setGroupId(String(key))}
            options={[
              { id: ALL, label: t("allGroups") },
              ...(groups.data ?? []).map((g) => ({ id: g.id, label: g.name })),
            ]}
          />
        </div>
        <div className="w-56">
          <TextField label={t("search")} type="search" value={search} onChange={setSearch} />
        </div>
        <Checkbox isSelected={showArchived} onChange={setShowArchived}>
          {t("showArchived")}
        </Checkbox>
        {canManage && (
          <div className="ms-auto flex gap-2">
            <Button className="btn-ghost" onPress={() => setManagingGroups(true)}>
              {tGroups("manage")}
            </Button>
            <Button onPress={() => setEditing(null)}>{t("add")}</Button>
          </div>
        )}
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
              <th>{t("titleField")}</th>
              <th>{t("size")}</th>
              <th>{t("weight")}</th>
              <th>{t("contents")}</th>
              <th>{t("groups")}</th>
              {canManage && (
                <th>
                  <span className="sr-only">{t("actions")}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {parcels.isPending && (
              <tr>
                <td colSpan={columns}>{t("loading")}</td>
              </tr>
            )}
            {parcels.error && (
              <tr>
                <td colSpan={columns} className="text-error">
                  {errorMessage(parcels.error)}
                </td>
              </tr>
            )}
            {parcels.data?.length === 0 && (
              <tr>
                <td colSpan={columns}>{t("empty")}</td>
              </tr>
            )}
            {parcels.data?.map((parcel) => (
              <tr
                key={parcel.id}
                data-testid="lab-parcel-row"
                className={parcel.archived ? "opacity-60" : ""}
              >
                <td>
                  <div className="font-medium">
                    {parcel.locked && (
                      <span role="img" aria-label={t("locked")} title={t("lockedReason")}>
                        🔒{" "}
                      </span>
                    )}
                    {parcel.title}
                  </div>
                  {parcel.description && (
                    <div className="text-sm opacity-70">{parcel.description}</div>
                  )}
                </td>
                <td>
                  {parcel.box && <div>{parcel.box.name}</div>}
                  <div className={parcel.box ? "text-sm opacity-70" : ""}>
                    {parcel.lengthIn} × {parcel.widthIn} × {parcel.heightIn}
                  </div>
                </td>
                <td>{formatWeight(parcel.weightOz, weightDisplay, locale)}</td>
                <td>
                  {parcel.items.length === 0
                    ? t("noContents")
                    : parcel.items.map((item) => (
                        <div key={item.product.id}>
                          {item.quantity} × {item.product.name}
                        </div>
                      ))}
                </td>
                <td className="space-x-1">
                  {parcel.groups.map((g) => (
                    <span key={g.id} className="badge badge-outline">
                      {g.name}
                    </span>
                  ))}
                  {parcel.archived && <span className="badge badge-ghost">{t("archived")}</span>}
                </td>
                {canManage && (
                  <td className="whitespace-nowrap text-right">
                    <Button className="btn-ghost btn-sm" onPress={() => setEditing(parcel)}>
                      {t("edit")}
                    </Button>
                    <Button
                      className="btn-ghost btn-sm"
                      isPending={duplicate.isPending && duplicate.variables?.id === parcel.id}
                      onPress={() =>
                        duplicate.mutate({ idempotencyKey: randomUUID(), id: parcel.id })
                      }
                    >
                      {t("duplicate")}
                    </Button>
                    {parcel.archived ? (
                      <Button
                        className="btn-ghost btn-sm"
                        isPending={unarchive.isPending && unarchive.variables?.id === parcel.id}
                        onPress={() => unarchive.mutate({ id: parcel.id })}
                      >
                        {t("unarchive")}
                      </Button>
                    ) : (
                      <Button
                        className="btn-ghost btn-sm"
                        isPending={archive.isPending && archive.variables?.id === parcel.id}
                        onPress={() => archive.mutate({ id: parcel.id })}
                      >
                        {t("archive")}
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
        <ParcelDialog
          key={editing?.id ?? "new"}
          parcel={editing}
          groups={groups.data ?? []}
          weightDisplay={weightDisplay}
          onClose={() => setEditing(false)}
        />
      )}
      {managingGroups && <GroupsDialog kind="PARCEL" onClose={() => setManagingGroups(false)} />}
    </div>
  );
}
