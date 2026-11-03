"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LabAddress } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { formatAddress } from "@/app/(app)/orders/[id]/address";
import { Button, Checkbox, SelectField, TextField } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { AddressDialog } from "./address-dialog";
import { GroupsDialog } from "./groups-dialog";

const ALL = "all";

export function AddressesManager({ canManage }: { canManage: boolean }) {
  const t = useTranslations("rateLab.addresses");
  const tGroups = useTranslations("rateLab.groups");
  const tShip = useTranslations("orderShipping");
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [groupId, setGroupId] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  // `false`: closed; `null`: adding; an address: editing it.
  const [editing, setEditing] = useState<LabAddress | null | false>(false);
  const [managingGroups, setManagingGroups] = useState(false);

  const groups = useQuery(
    orpc.rateLab.groups.queryOptions({ input: { kind: "ADDRESS", includeArchived: false } }),
  );
  const addresses = useQuery(
    orpc.rateLab.addresses.queryOptions({
      input: {
        includeArchived: showArchived,
        groupIds: groupId === ALL ? [] : [groupId],
        search,
      },
    }),
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.rateLab.key() });
  const archive = useMutation(orpc.rateLab.archiveAddress.mutationOptions({ onSuccess: refresh }));
  const unarchive = useMutation(
    orpc.rateLab.unarchiveAddress.mutationOptions({ onSuccess: refresh }),
  );
  const duplicate = useMutation(
    orpc.rateLab.duplicateAddress.mutationOptions({
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
              <th>{t("address")}</th>
              <th>{t("check")}</th>
              <th>{t("type")}</th>
              <th>{t("groups")}</th>
              {canManage && (
                <th>
                  <span className="sr-only">{t("actions")}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {addresses.isPending && (
              <tr>
                <td colSpan={columns}>{t("loading")}</td>
              </tr>
            )}
            {addresses.error && (
              <tr>
                <td colSpan={columns} className="text-error">
                  {errorMessage(addresses.error)}
                </td>
              </tr>
            )}
            {addresses.data?.length === 0 && (
              <tr>
                <td colSpan={columns}>{t("empty")}</td>
              </tr>
            )}
            {addresses.data?.map((address) => (
              <tr
                key={address.id}
                data-testid="lab-address-row"
                className={address.archived ? "opacity-60" : ""}
              >
                <td>
                  <div className="font-medium">
                    {address.locked && (
                      <span role="img" aria-label={t("locked")} title={t("lockedReason")}>
                        🔒{" "}
                      </span>
                    )}
                    {address.title}
                  </div>
                  {address.description && (
                    <div className="text-sm opacity-70">{address.description}</div>
                  )}
                </td>
                <td>{formatAddress(address.address)}</td>
                <td>{tShip(`shipToStatus.${address.checkStatus}`)}</td>
                <td>{address.residential ? t("residential") : t("commercial")}</td>
                <td className="space-x-1">
                  {address.groups.map((g) => (
                    <span key={g.id} className="badge badge-outline">
                      {g.name}
                    </span>
                  ))}
                  {address.archived && <span className="badge badge-ghost">{t("archived")}</span>}
                </td>
                {canManage && (
                  <td className="whitespace-nowrap text-right">
                    <Button className="btn-ghost btn-sm" onPress={() => setEditing(address)}>
                      {t("edit")}
                    </Button>
                    <Button
                      className="btn-ghost btn-sm"
                      isPending={duplicate.isPending && duplicate.variables?.id === address.id}
                      onPress={() =>
                        duplicate.mutate({ idempotencyKey: crypto.randomUUID(), id: address.id })
                      }
                    >
                      {t("duplicate")}
                    </Button>
                    {address.archived ? (
                      <Button
                        className="btn-ghost btn-sm"
                        isPending={unarchive.isPending && unarchive.variables?.id === address.id}
                        onPress={() => unarchive.mutate({ id: address.id })}
                      >
                        {t("unarchive")}
                      </Button>
                    ) : (
                      <Button
                        className="btn-ghost btn-sm"
                        isPending={archive.isPending && archive.variables?.id === address.id}
                        onPress={() => archive.mutate({ id: address.id })}
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
        <AddressDialog
          key={editing?.id ?? "new"}
          address={editing}
          groups={groups.data ?? []}
          onSaved={setEditing}
          onDuplicated={setEditing}
          onClose={() => setEditing(false)}
        />
      )}
      {managingGroups && <GroupsDialog onClose={() => setManagingGroups(false)} />}
    </div>
  );
}
