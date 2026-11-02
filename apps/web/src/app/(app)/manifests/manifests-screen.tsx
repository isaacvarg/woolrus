"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

/** The browser's calendar day as YYYY-MM-DD: the warehouse's "today". */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const pdfUrl = (id: string) => `/api/manifests/${id}.pdf`;

/** Manifests (FR-SHIP-14): a day's shipped labels per carrier account, a button to manifest them, the PDF to print. */
export function ManifestsScreen() {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [shipDate, setShipDate] = useState<string | null>(null);
  // One key per carrier and day until it succeeds, so a retried press can never manifest twice.
  const keys = useRef(new Map<string, string>());

  useEffect(() => setShipDate(today()), []);

  const candidates = useQuery({
    ...orpc.shipping.manifestCandidates.queryOptions({ input: { shipDate: shipDate ?? today() } }),
    enabled: shipDate !== null,
  });

  const create = useMutation({
    mutationFn: ({ carrierId, date }: { carrierId: string; date: string }) => {
      const slot = `${carrierId}:${date}`;
      const idempotencyKey = keys.current.get(slot) ?? crypto.randomUUID();
      keys.current.set(slot, idempotencyKey);
      return client.shipping.createManifest({ carrierId, shipDate: date, idempotencyKey });
    },
    onSuccess: async (made, { carrierId, date }) => {
      keys.current.delete(`${carrierId}:${date}`);
      await queryClient.invalidateQueries({ queryKey: orpc.shipping.key() });
      toast.success(t("manifests.created", { count: made.labelCount }));
      window.open(pdfUrl(made.manifestId), "_blank", "noopener");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-3">
        <span className="font-medium">{t("manifests.date")}</span>
        <input
          type="date"
          className="input input-bordered"
          value={shipDate ?? ""}
          onChange={(event) => event.target.value && setShipDate(event.target.value)}
        />
      </label>

      {shipDate === null || candidates.isPending ? (
        <p>{t("common.loading")}</p>
      ) : candidates.error ? (
        <p role="alert" className="text-error">
          {errorMessage(candidates.error)}
        </p>
      ) : candidates.data.carriers.length === 0 ? (
        <p>{t("manifests.empty")}</p>
      ) : (
        <ul className="space-y-3">
          {candidates.data.carriers.map((carrier) => (
            <li key={carrier.carrierId} className="card bg-base-100 shadow-sm">
              <div className="card-body gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="card-title">{carrier.name}</h2>
                    <p>{t("manifests.unmanifested", { count: carrier.unmanifested })}</p>
                  </div>
                  <Button
                    variant="primary"
                    isDisabled={carrier.unmanifested === 0 || create.isPending}
                    onPress={() => create.mutate({ carrierId: carrier.carrierId, date: shipDate })}
                  >
                    {t("manifests.create")}
                  </Button>
                </div>
                {carrier.manifests.length > 0 && (
                  <ul className="space-y-1">
                    {carrier.manifests.map((manifest) => (
                      <li key={manifest.id} className="flex flex-wrap items-center gap-3">
                        <span>
                          {t("manifests.made", {
                            time: format.dateTime(manifest.createdAt, { timeStyle: "short" }),
                            count: manifest.labelCount,
                          })}
                        </span>
                        <a
                          className="link"
                          href={pdfUrl(manifest.id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t("manifests.print")}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
