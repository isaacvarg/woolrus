"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkflowStatus } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import {
  type IssueTargetOption,
  ReportIssueDialog,
  type ReportIssueDialogInput,
} from "./report-issue-dialog";

/**
 * `ReportIssueDialog` wired to `issues.report` for the floor screens (pick, pack): mount it while
 * the dialog is open, preselected on the line or package it was opened from.
 */
export function ReportIssueFlow({
  order,
  canWriteCustomer,
  targets,
  initialTarget,
  onClose,
}: {
  order: { id: string; status: WorkflowStatus; heldFromStatus: WorkflowStatus | null };
  canWriteCustomer: boolean;
  targets: IssueTargetOption[];
  initialTarget: Pick<IssueTargetOption, "orderItemId" | "packageId">;
  onClose: () => void;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const report = useMutation({
    mutationFn: (input: ReportIssueDialogInput) =>
      client.issues.report({ orderId: order.id, ...input }),
    onSuccess: () => toast.success(t("issues.reported")),
    onError: (error) => toast.error(errorMessage(error)),
    // The queue's badge and the order detail read the new issue.
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
  });
  return (
    <ReportIssueDialog
      orderId={order.id}
      status={order.status}
      heldFromStatus={order.heldFromStatus}
      canWriteCustomer={canWriteCustomer}
      targets={targets}
      initialTarget={initialTarget}
      isOpen
      onOpenChange={(open) => !open && onClose()}
      isPending={report.isPending}
      onReport={report.mutateAsync}
    />
  );
}
