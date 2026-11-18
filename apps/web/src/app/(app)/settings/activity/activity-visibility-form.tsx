"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityPart,
  type ActivityVisibility,
  ActivityVisibilityRole,
  type AdminSettings,
} from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

// Settings → Activity (SPEC-order-activity "Visibility"): per role, which parts of an order's
// activity view it sees. Every part starts on; Admins always see everything, so they have no row.
// Each switch saves at once.

export function ActivityVisibilitySection() {
  const errorMessage = useErrorMessage();
  const settings = useQuery(orpc.settings.get.queryOptions());

  if (settings.isPending) return <span className="loading loading-spinner" />;
  if (settings.error) {
    return (
      <p role="alert" className="alert alert-error">
        {errorMessage(settings.error)}
      </p>
    );
  }
  return <ActivityVisibilityTable settings={settings.data} />;
}

function ActivityVisibilityTable({ settings }: { settings: AdminSettings }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const visibility = settings.activityVisibility;

  const save = useMutation(
    orpc.settings.update.mutationOptions({
      onSuccess: (updated) => {
        queryClient.setQueryData(orpc.settings.get.queryKey(), updated);
        toast.success(t("settings.activity.saved"));
      },
      onError: (error) => toast.error(errorMessage(error)),
    }),
  );

  const toggle = (role: ActivityVisibilityRole, part: ActivityPart, on: boolean) => {
    const next: ActivityVisibility = { ...visibility, [role]: { ...visibility[role], [part]: on } };
    save.mutate({ activityVisibility: next });
  };

  return (
    <div className="card bg-base-100 shadow-sm">
      <div className="card-body overflow-x-auto">
        <table className="table">
          <caption className="sr-only">{t("settings.activity.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("settings.activity.role")}</th>
              {ActivityPart.options.map((part) => (
                <th key={part} scope="col">
                  {t(`settings.activity.part.${part}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ActivityVisibilityRole.options.map((role) => (
              <tr key={role}>
                <th scope="row">{t(`users.role.${role}`)}</th>
                {ActivityPart.options.map((part) => (
                  <td key={part}>
                    <Switch
                      isSelected={visibility[role]?.[part] !== false}
                      isDisabled={save.isPending}
                      onChange={(on) => toggle(role, part, on)}
                      aria-label={t("settings.activity.switch", {
                        role: t(`users.role.${role}`),
                        part: t(`settings.activity.part.${part}`),
                      })}
                    >
                      {null}
                    </Switch>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="text-sm text-base-content/70 space-y-1">
          {ActivityPart.options.map((part) => (
            <li key={part}>
              <span className="font-semibold">{t(`settings.activity.part.${part}`)}:</span>{" "}
              {t(`settings.activity.hint.${part}`)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
