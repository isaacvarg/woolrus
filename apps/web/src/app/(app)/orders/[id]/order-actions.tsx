"use client";

import { ORPCError } from "@orpc/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type OrderAction,
  type OrderDetail,
  type OrderView,
  WorkflowStatus,
} from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Button, Radio, RadioGroup, TextField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { useReasonText } from "@/lib/reasons";

type Unmet = { messageKey: string; params: Record<string, string | number> };

/** What a refused gate still needs, from the error's `data.unmet` (see AppErrorData). */
function unmetOf(error: unknown): Unmet[] | null {
  if (!(error instanceof ORPCError)) return null;
  const unmet = (error.data as { unmet?: Unmet[] } | undefined)?.unmet;
  return unmet?.length ? unmet : null;
}

type Run = {
  action: OrderAction;
  call: () => Promise<OrderDetail>;
  /** The success toast, from the order as it came back (resume lands on the held-from stage). */
  done: (order: OrderDetail) => string;
};

/** Stage moves that need no dialog, in the order they're shown. */
const moves = [
  "beginPicking",
  "completePicking",
  "completePacking",
  "completeQa",
  "resume",
] as const;

/**
 * The claim banner, the action buttons and their dialogs. Only actions the server listed in
 * `allowedActions` are shown; the server checks each one again.
 */
export function OrderActions({ order, userId }: { order: OrderView; userId: string | null }) {
  const t = useTranslations();
  const reasonText = useReasonText();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [unmet, setUnmet] = useState<Unmet[] | null>(null);
  const can = (action: OrderAction) => order.allowedActions.includes(action);
  const versioned = { id: order.id, expectedVersion: order.version };

  // One mutation runs every action: only one is in flight, and its button shows as pending.
  const mutation = useMutation({
    mutationFn: ({ call }: Run) => call(),
    onMutate: () => setUnmet(null),
    onSuccess: (result, { done }) => toast.success(done(result)),
    onError: (error) => {
      const missing = unmetOf(error);
      if (missing) setUnmet(missing);
      else toast.error(errorMessage(error));
    },
    // Refetch either way: a stale version means another station moved it.
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
  });
  const pending = (action: OrderAction) =>
    mutation.isPending && mutation.variables?.action === action;
  const moved = (result: OrderDetail) =>
    t("order.moved", { number: result.number, status: t(`status.${result.status}`) });
  /** Runs an action from a dialog, closing it only on success so a refusal can be read. */
  const runAndClose = (run: Run, close: () => void) =>
    mutation.mutateAsync(run).then(close, () => {});

  const holder = order.claim;
  const mine = holder !== null && holder.userId === userId;

  return (
    <div className="space-y-4">
      <div
        className={`alert ${holder ? (mine ? "alert-info" : "alert-warning") : ""} flex flex-wrap`}
      >
        <span className="grow">
          {holder
            ? t("order.claimedBy", {
                name: holder.userName,
                time: format.relativeTime(holder.at, new Date()),
              })
            : t("order.unclaimed")}
        </span>
        {can("claim") && (
          <Button
            className="btn-outline"
            isPending={pending("claim")}
            onPress={() =>
              mutation.mutate({
                action: "claim",
                call: () => client.orders.claim(versioned),
                done: (o) => t("order.claimed", { number: o.number }),
              })
            }
          >
            {t("order.actions.claim")}
          </Button>
        )}
        {can("release") && (
          <Button
            className="btn-outline"
            isPending={pending("release")}
            onPress={() =>
              mutation.mutate({
                action: "release",
                call: () => client.orders.release({ id: order.id }),
                done: (o) => t("order.released", { number: o.number }),
              })
            }
          >
            {t("order.actions.release")}
          </Button>
        )}
        {can("takeOver") && holder && (
          <DialogTrigger>
            <Button className="btn-warning">{t("order.actions.takeOver")}</Button>
            <Dialog title={t("order.takeOverTitle")}>
              {(close) => (
                <>
                  <p>{t("order.takeOverBody", { name: holder.userName })}</p>
                  <div className="modal-action">
                    <Button className="btn-ghost" onPress={close}>
                      {t("order.back")}
                    </Button>
                    <Button
                      className="btn-warning"
                      isPending={pending("takeOver")}
                      onPress={() =>
                        runAndClose(
                          {
                            action: "takeOver",
                            call: () => client.orders.takeOver({ ...versioned, confirm: true }),
                            done: (o) => t("order.tookOver", { number: o.number }),
                          },
                          close,
                        )
                      }
                    >
                      {t("order.actions.takeOver")}
                    </Button>
                  </div>
                </>
              )}
            </Dialog>
          </DialogTrigger>
        )}
      </div>

      {order.status === "ON_HOLD" && order.holdReason && (
        <p className="alert alert-warning">
          {t("order.onHold", {
            status: order.heldFromStatus ? t(`status.${order.heldFromStatus}`) : "—",
            reason: reasonText(order.holdReason),
          })}
        </p>
      )}

      {unmet && (
        <div role="alert" className="alert alert-error flex-col items-start">
          <p className="font-semibold">{t("errors.workflow.gateFailed")}</p>
          <ul className="list-disc ps-6">
            {unmet.map((condition) => (
              <li key={`${condition.messageKey}:${JSON.stringify(condition.params)}`}>
                {t.has(condition.messageKey)
                  ? t(condition.messageKey, condition.params as never)
                  : t("errors.internal")}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {moves.filter(can).map((action) => (
          <Button
            key={action}
            className="btn-primary btn-lg"
            isPending={pending(action)}
            onPress={() =>
              mutation.mutate({ action, call: () => client.orders[action](versioned), done: moved })
            }
          >
            {t(`order.actions.${action}`)}
          </Button>
        ))}
        {can("hold") && (
          <ReasonDialog
            action="hold"
            title={t("order.holdTitle")}
            buttonClass="btn-warning"
            isPending={pending("hold")}
            onSubmit={(reason, close) =>
              runAndClose(
                {
                  action: "hold",
                  call: () => client.orders.hold({ ...versioned, reason }),
                  done: moved,
                },
                close,
              )
            }
          />
        )}
        {can("cancel") && (
          <ReasonDialog
            action="cancel"
            title={t("order.cancelTitle")}
            buttonClass="btn-error"
            isPending={pending("cancel")}
            onSubmit={(reason, close) =>
              runAndClose(
                {
                  action: "cancel",
                  call: () => client.orders.cancel({ ...versioned, reason }),
                  done: moved,
                },
                close,
              )
            }
          />
        )}
        {can("forceStatus") && (
          <ReasonDialog
            action="forceStatus"
            title={t("order.forceTitle")}
            buttonClass="btn-error btn-outline"
            isPending={pending("forceStatus")}
            current={order.status}
            onSubmit={(reason, close, to) =>
              to &&
              runAndClose(
                {
                  action: "forceStatus",
                  call: () => client.orders.forceStatus({ ...versioned, reason, to }),
                  done: moved,
                },
                close,
              )
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * A button opening a dialog that asks for a reason (hold, cancel), and for force also the status
 * to move to: any status but the current one.
 */
function ReasonDialog({
  action,
  title,
  buttonClass,
  isPending,
  current,
  onSubmit,
}: {
  action: "hold" | "cancel" | "forceStatus";
  title: string;
  buttonClass: string;
  isPending: boolean;
  /** Force only: the order's status, left out of the choices. */
  current?: WorkflowStatus;
  onSubmit: (reason: string, close: () => void, to?: WorkflowStatus) => void;
}) {
  const t = useTranslations();
  const [reason, setReason] = useState("");
  const [to, setTo] = useState<WorkflowStatus | null>(null);
  const label = t(`order.actions.${action}`);

  return (
    <DialogTrigger
      onOpenChange={(open) => {
        if (open) return;
        setReason("");
        setTo(null);
      }}
    >
      <Button className={`${buttonClass} btn-lg`}>{label}</Button>
      <Dialog title={title}>
        {(close) => (
          <Form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit(reason.trim(), close, to ?? undefined);
            }}
          >
            {current && (
              <>
                <p className="text-sm">{t("order.forceHint")}</p>
                <RadioGroup
                  label={t("order.newStatus")}
                  name="to"
                  isRequired
                  value={to}
                  onChange={(value) => setTo(value as WorkflowStatus)}
                >
                  {WorkflowStatus.options
                    .filter((status) => status !== current)
                    .map((status) => (
                      <Radio key={status} value={status}>
                        {t(`status.${status}`)}
                      </Radio>
                    ))}
                </RadioGroup>
              </>
            )}
            <TextField
              label={t("order.reason")}
              name="reason"
              isRequired
              maxLength={500}
              // Whitespace alone is no reason; the server trims and refuses it too.
              validate={(value) => (value.trim() ? null : t("errors.field.required"))}
              value={reason}
              onChange={setReason}
              autoFocus
            />
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("order.back")}
              </Button>
              <Button type="submit" className={buttonClass} isPending={isPending}>
                {label}
              </Button>
            </div>
          </Form>
        )}
      </Dialog>
    </DialogTrigger>
  );
}
