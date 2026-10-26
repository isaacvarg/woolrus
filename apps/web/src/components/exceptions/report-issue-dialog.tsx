"use client";

import {
  type FulfillmentStage,
  ISSUE_DESCRIPTION_MAX,
  type QualityIssueSeverity,
  type QualityIssueType,
  type QualityIssueView,
  type WorkflowStatus,
} from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Form, type ModalOverlayProps } from "react-aria-components";
import { NoteComposer } from "@/components/notes/note-composer";
import { Dialog } from "@/components/ui/dialog";
import { Button, Checkbox, TextAreaField } from "@/components/ui/fields";

export type ReportIssueDialogInput = {
  orderItemId?: string;
  packageId?: string;
  type: QualityIssueType;
  severity: QualityIssueSeverity;
  description: string;
  originStage?: FulfillmentStage;
  customerReported: boolean;
};

/** Something the issue can be about besides the whole order; `label` is already worded. */
export type IssueTargetOption = { orderItemId?: string; packageId?: string; label: string };

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
const origins: FulfillmentStage[] = ["INTAKE", "PICKING", "PACKING", "QA", "SHIPPING"];

/** The stage an order is in, as the server records it for a new issue (`stageFor`). */
export function discoveredStageOf(
  status: WorkflowStatus,
  heldFromStatus: WorkflowStatus | null,
): FulfillmentStage {
  const at = status === "ON_HOLD" ? heldFromStatus : status;
  if (at === "PICKING" || at === "PACKING" || at === "QA") return at;
  if (at === "READY") return "SHIPPING";
  if (at === "COMPLETED") return "CUSTOMER";
  return "INTAKE";
}

const targetKey = (o: Pick<IssueTargetOption, "orderItemId" | "packageId">) =>
  o.orderItemId ? `item:${o.orderItemId}` : o.packageId ? `package:${o.packageId}` : "order";

/**
 * Reports a quality issue (SPEC-exceptions "UI"): type, severity, description, where it started,
 * then an optional step to add photos or a voice memo through the notes composer. It only gathers
 * the answer: the caller runs the mutation in `onReport`, which resolves to the new issue. `qa`
 * embeds it as is. Mount it per use, with `isOpen`.
 */
export function ReportIssueDialog({
  orderId,
  status,
  heldFromStatus,
  canWriteCustomer,
  targets = [],
  initialTarget,
  onReport,
  onDone,
  isPending = false,
  ...overlay
}: Omit<ModalOverlayProps, "children"> & {
  orderId: string;
  status: WorkflowStatus;
  heldFromStatus: WorkflowStatus | null;
  canWriteCustomer: boolean;
  /** Lines and packages the issue can be about, besides the whole order. */
  targets?: IssueTargetOption[];
  /** Preselects a line or package, e.g. when opened from one. */
  initialTarget?: Pick<IssueTargetOption, "orderItemId" | "packageId">;
  onReport: (input: ReportIssueDialogInput) => Promise<QualityIssueView>;
  /** The dialog closed after the issue was reported, with or without evidence. */
  onDone?: (issue: QualityIssueView) => void;
  isPending?: boolean;
}) {
  const t = useTranslations();
  const ids = { target: useId(), type: useId(), severity: useId(), origin: useId() };
  const [target, setTarget] = useState(initialTarget ? targetKey(initialTarget) : "order");
  const [type, setType] = useState<QualityIssueType>("OTHER");
  const [severity, setSeverity] = useState<QualityIssueSeverity>("MINOR");
  const [description, setDescription] = useState("");
  const [origin, setOrigin] = useState<FulfillmentStage | "">("");
  const [customerReported, setCustomerReported] = useState(false);
  const [issue, setIssue] = useState<QualityIssueView | null>(null);
  const canBeCustomer = status === "READY" || status === "COMPLETED";
  const discovered = customerReported ? "CUSTOMER" : discoveredStageOf(status, heldFromStatus);
  const chosen = targets.find((o) => targetKey(o) === target);

  return (
    <Dialog title={t("issues.title")} {...overlay}>
      {(close) =>
        issue ? (
          <div className="space-y-4" data-testid="issue-evidence">
            <p className="font-semibold">{t("issues.evidenceTitle")}</p>
            <p className="text-sm opacity-70">{t("issues.evidenceHint")}</p>
            <NoteComposer
              orderId={orderId}
              canWriteCustomer={canWriteCustomer}
              initialTarget={{ kind: "issue", id: issue.id }}
              onAdded={() => {
                onDone?.(issue);
                close();
              }}
            />
            <div className="modal-action">
              <Button
                className="btn-ghost"
                onPress={() => {
                  onDone?.(issue);
                  close();
                }}
              >
                {t("issues.skip")}
              </Button>
            </div>
          </div>
        ) : (
          <Form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void onReport({
                ...(chosen?.orderItemId ? { orderItemId: chosen.orderItemId } : {}),
                ...(chosen?.packageId ? { packageId: chosen.packageId } : {}),
                type,
                severity,
                description: description.trim(),
                ...(origin ? { originStage: origin } : {}),
                customerReported,
              }).then(setIssue, () => {});
            }}
          >
            {targets.length > 0 && (
              <div className="fieldset">
                <label htmlFor={ids.target} className="fieldset-legend">
                  {t("issues.on")}
                </label>
                {/* Native on purpose: tablets open their own large picker. */}
                <select
                  id={ids.target}
                  className="select select-lg w-full"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  <option value="order">{t("issues.onOrder")}</option>
                  {targets.map((o) => (
                    <option key={targetKey(o)} value={targetKey(o)}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="fieldset">
                <label htmlFor={ids.type} className="fieldset-legend">
                  {t("issues.type")}
                </label>
                <select
                  id={ids.type}
                  className="select select-lg w-full"
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
                  className="select select-lg w-full"
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
              // Whitespace alone says nothing; the server trims and refuses it too.
              validate={(value) => (value.trim() ? null : t("errors.field.required"))}
              value={description}
              onChange={setDescription}
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="fieldset">
                <span className="fieldset-legend">{t("issues.discovered")}</span>
                <p className="py-2 font-medium" data-testid="issue-discovered">
                  {t(`voids.stage.${discovered}`)}
                </p>
              </div>
              <div className="fieldset">
                <label htmlFor={ids.origin} className="fieldset-legend">
                  {t("issues.origin")}
                </label>
                <select
                  id={ids.origin}
                  className="select select-lg w-full"
                  value={origin}
                  onChange={(event) => setOrigin(event.target.value as FulfillmentStage | "")}
                >
                  <option value="">{t("issues.originNone")}</option>
                  {origins.map((id) => (
                    <option key={id} value={id}>
                      {t(`voids.stage.${id}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {canBeCustomer && (
              <div>
                <Checkbox isSelected={customerReported} onChange={setCustomerReported}>
                  {t("issues.customerReported")}
                </Checkbox>
                <p className="text-sm opacity-70">{t("issues.customerReportedHint")}</p>
              </div>
            )}
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("order.back")}
              </Button>
              <Button type="submit" isPending={isPending}>
                {t("issues.submit")}
              </Button>
            </div>
          </Form>
        )
      }
    </Dialog>
  );
}
