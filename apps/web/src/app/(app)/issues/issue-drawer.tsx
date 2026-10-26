"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ISSUE_DESCRIPTION_MAX,
  ISSUE_NOTES_MAX,
  type IssueRow,
  type QualityIssueSeverity,
  type QualityIssueType,
} from "@woolrus/contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Form, Heading, Modal, ModalOverlay } from "react-aria-components";
import { IssueCard } from "@/components/exceptions/issue-card";
import { NoteList } from "@/components/notes/note-list";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextAreaField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

const types: QualityIssueType[] = [
  "WRONG_ITEM",
  "DAMAGED_ITEM",
  "MISSING_ITEM",
  "WRONG_QUANTITY",
  "PACKAGING_DAMAGE",
  "LABELING_ERROR",
  "WRONG_BOX_SIZE",
  "OTHER",
];
const severities: QualityIssueSeverity[] = ["MINOR", "MAJOR", "CRITICAL"];

/** Refreshes every issue and order read after a change, like the live stream does for others. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.issues.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
    ]);
}

/**
 * One issue in a side drawer: facts, description, notes and photos, and the actions the viewer
 * may take. The reporter or an Admin edits an open issue and changes the responsible user; an
 * Admin resolves, dismisses or reopens it with a required note.
 */
export function IssueDrawer({
  issueId,
  canResolve,
  canWriteCustomer,
  userId,
  onClose,
}: {
  issueId: string;
  canResolve: boolean;
  canWriteCustomer: boolean;
  userId: string | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const refresh = useRefresh();
  const issue = useQuery(orpc.issues.get.queryOptions({ input: { issueId } }));
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState<"RESOLVED" | "DISMISSED" | null>(null);
  const data = issue.data;
  const canEdit = !!data && data.status === "OPEN" && (canResolve || data.reporterId === userId);

  const reopen = useMutation({
    mutationFn: () => client.issues.reopen({ issueId }),
    onSuccess: () => toast.success(t("issues.page.reopened")),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: refresh,
  });

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && onClose()}
      className="fixed inset-0 z-40 flex justify-end bg-black/40"
    >
      <Modal className="h-full w-full max-w-xl overflow-y-auto bg-base-100 p-6 shadow-xl">
        <section
          aria-labelledby="issue-drawer-title"
          className="space-y-4 outline-none"
          data-testid="issue-drawer"
        >
          <div className="flex items-start gap-3">
            <Heading slot="title" id="issue-drawer-title" className="grow text-xl font-bold">
              {data ? t("issues.page.details", { number: data.orderNumber }) : t("common.loading")}
            </Heading>
            <Button className="btn-ghost" onPress={onClose}>
              {t("issues.page.close")}
            </Button>
          </div>
          {issue.error && <p className="text-error">{errorMessage(issue.error)}</p>}
          {data && (
            <>
              <IssueCard issue={data} />
              {data.resolutionNotes && (
                <p className="rounded-box bg-base-200 p-3" data-testid="issue-resolution">
                  {t("issues.page.resolution", { notes: data.resolutionNotes })}
                </p>
              )}
              <Link href={`/orders/${data.orderId}`} className="link">
                {t("issues.page.openOrder")} #{data.orderNumber}
              </Link>

              <div className="flex flex-wrap gap-2">
                {canEdit && !editing && (
                  <Button className="btn-outline" onPress={() => setEditing(true)}>
                    {t("issues.page.edit")}
                  </Button>
                )}
                {canResolve && data.status === "OPEN" && (
                  <>
                    <Button onPress={() => setClosing("RESOLVED")}>
                      {t("issues.page.resolve")}
                    </Button>
                    <Button className="btn-outline" onPress={() => setClosing("DISMISSED")}>
                      {t("issues.page.dismiss")}
                    </Button>
                  </>
                )}
                {canResolve && data.status !== "OPEN" && (
                  <Button isPending={reopen.isPending} onPress={() => reopen.mutate()}>
                    {t("issues.page.reopen")}
                  </Button>
                )}
              </div>

              {editing && <EditForm issue={data} onDone={() => setEditing(false)} />}
              {canEdit && <ResponsiblePicker issue={data} />}

              <div className="space-y-2">
                <h3 className="font-semibold">{t("issues.page.notes")}</h3>
                <NoteList
                  orderId={data.orderId}
                  canWriteCustomer={canWriteCustomer}
                  issueId={data.id}
                />
              </div>
            </>
          )}
        </section>
        {closing && (
          <CloseDialog
            issueId={issueId}
            outcome={closing}
            onClose={() => setClosing(null)}
            onDone={refresh}
          />
        )}
      </Modal>
    </ModalOverlay>
  );
}

function EditForm({ issue, onDone }: { issue: IssueRow; onDone: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const refresh = useRefresh();
  const ids = { type: useId(), severity: useId() };
  const [type, setType] = useState(issue.type);
  const [severity, setSeverity] = useState(issue.severity);
  const [description, setDescription] = useState(issue.description);
  const update = useMutation({
    mutationFn: () => client.issues.update({ issueId: issue.id, type, severity, description }),
    onSuccess: () => {
      toast.success(t("issues.page.saved"));
      onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: refresh,
  });

  return (
    <Form
      className="space-y-3 rounded-box border border-base-300 p-3"
      validationErrors={fieldErrors(update.error)}
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="fieldset">
          <label htmlFor={ids.type} className="fieldset-legend">
            {t("issues.type")}
          </label>
          <select
            id={ids.type}
            className="select w-full"
            value={type}
            onChange={(event) => setType(event.target.value as QualityIssueType)}
          >
            {types.map((id) => (
              <option key={id} value={id}>
                {t(`issues.types.${id}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="fieldset">
          <label htmlFor={ids.severity} className="fieldset-legend">
            {t("issues.severity")}
          </label>
          <select
            id={ids.severity}
            className="select w-full"
            value={severity}
            onChange={(event) => setSeverity(event.target.value as QualityIssueSeverity)}
          >
            {severities.map((id) => (
              <option key={id} value={id}>
                {t(`issues.severities.${id}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <TextAreaField
        label={t("issues.description")}
        name="description"
        isRequired
        maxLength={ISSUE_DESCRIPTION_MAX}
        validate={(value) => (value.trim() ? null : t("errors.field.required"))}
        value={description}
        onChange={setDescription}
      />
      <div className="flex gap-2">
        <Button type="submit" isPending={update.isPending}>
          {t("issues.page.save")}
        </Button>
        <Button className="btn-ghost" onPress={onDone}>
          {t("issues.page.cancel")}
        </Button>
      </div>
    </Form>
  );
}

function ResponsiblePicker({ issue }: { issue: IssueRow }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const refresh = useRefresh();
  const id = useId();
  const assignees = useQuery(orpc.issues.assignees.queryOptions());
  const set = useMutation({
    mutationFn: (userId: string | null) =>
      client.issues.setResponsible({ issueId: issue.id, userId }),
    onSuccess: () => toast.success(t("issues.page.responsibleSaved")),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: refresh,
  });

  return (
    <div className="fieldset">
      <label htmlFor={id} className="fieldset-legend">
        {t("issues.page.change")}
      </label>
      <select
        id={id}
        className="select w-full"
        disabled={set.isPending || !assignees.data}
        value={issue.responsible?.id ?? ""}
        onChange={(event) => set.mutate(event.target.value || null)}
      >
        <option value="">{t("issues.page.nobody")}</option>
        {assignees.data?.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function CloseDialog({
  issueId,
  outcome,
  onClose,
  onDone,
}: {
  issueId: string;
  outcome: "RESOLVED" | "DISMISSED";
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const [notes, setNotes] = useState("");
  const resolve = useMutation({
    mutationFn: () => client.issues.resolve({ issueId, outcome, notes }),
    onSuccess: () => {
      toast.success(
        t(outcome === "RESOLVED" ? "issues.page.resolvedToast" : "issues.page.dismissedToast"),
      );
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: onDone,
  });
  const resolving = outcome === "RESOLVED";

  return (
    <Dialog
      title={t(resolving ? "issues.page.resolveTitle" : "issues.page.dismissTitle")}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <Form
          className="space-y-4"
          validationErrors={fieldErrors(resolve.error)}
          onSubmit={(event) => {
            event.preventDefault();
            resolve.mutate();
          }}
        >
          <TextAreaField
            label={t("issues.page.note")}
            description={t("issues.page.noteHint")}
            name="notes"
            isRequired
            maxLength={ISSUE_NOTES_MAX}
            validate={(value) => (value.trim() ? null : t("errors.field.required"))}
            value={notes}
            onChange={setNotes}
          />
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" isPending={resolve.isPending}>
              {t(resolving ? "issues.page.confirmResolve" : "issues.page.confirmDismiss")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}
