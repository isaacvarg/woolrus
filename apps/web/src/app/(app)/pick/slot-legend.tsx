"use client";

import type { PickBatch, PickBatchMember } from "@woolrus/contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

const stateBadge = { live: "badge-success", left: "badge-ghost", removed: "badge-ghost" } as const;

/** Slot → order and its state; members that left or were removed are greyed (SPEC-picking "UI"). */
export function SlotLegend({
  batch,
  actions,
}: {
  batch: PickBatch;
  /** Per-slot buttons, for the batch's owner. */
  actions?: (member: PickBatchMember) => ReactNode;
}) {
  const t = useTranslations();
  return (
    <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
      <table className="table text-base" aria-label={t("pickBatch.slots")}>
        <thead>
          <tr>
            <th>{t("pickBatch.slot")}</th>
            <th>{t("queue.number")}</th>
            <th>{t("queue.customer")}</th>
            <th>{t("pickBatch.state")}</th>
            {actions && (
              <th>
                <span className="sr-only">{t("pickBatch.actions")}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {batch.members.map((member) => (
            <tr
              key={member.orderId}
              className={member.state === "live" ? "h-14" : "h-14 opacity-50"}
              data-testid={`slot-${member.slot}`}
            >
              <td className="text-2xl font-bold tabular-nums">{member.slot}</td>
              <td className="font-semibold whitespace-nowrap">
                {member.state === "live" ? (
                  <Link href={`/pick/${member.orderId}`} className="link link-hover">
                    #{member.number}
                  </Link>
                ) : (
                  <Link href={`/orders/${member.orderId}`} className="link link-hover">
                    #{member.number}
                  </Link>
                )}
              </td>
              <td>{member.customerName}</td>
              <td>
                <span className={`badge ${stateBadge[member.state]}`}>
                  {member.left
                    ? t(`pickBatch.left.${member.left.reason}`, {
                        status: t(`status.${member.status}`),
                        name: member.left.reason === "takenOver" ? member.left.name : "",
                      })
                    : t(`pickBatch.memberState.${member.state}`)}
                </span>
              </td>
              {actions && <td>{actions(member)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
