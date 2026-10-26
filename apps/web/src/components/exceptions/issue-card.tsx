"use client";

import type { QualityIssueView } from "@woolrus/contracts";
import { useTranslations } from "next-intl";

const severityBadge = {
  MINOR: "badge-ghost",
  MAJOR: "badge-warning",
  CRITICAL: "badge-error",
} as const;

/**
 * One quality issue: what, how bad, where, and who is responsible (SPEC-exceptions "UI"). The
 * severity is a word and an icon as well as a colour. Display only, so other screens embed it.
 */
export function IssueCard({ issue }: { issue: QualityIssueView }) {
  const t = useTranslations();
  const critical = issue.severity === "CRITICAL" && issue.status === "OPEN";
  return (
    <article
      className={`space-y-1 rounded-box border p-3 ${critical ? "border-error" : "border-base-300"}`}
      data-testid="issue-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge ${severityBadge[issue.severity]}`}>
          {critical && <span aria-hidden="true">⚠ </span>}
          {t(`issues.severities.${issue.severity}`)}
        </span>
        <span className="font-semibold">{t(`issues.types.${issue.type}`)}</span>
        <span className="badge badge-outline">{t(`issues.statuses.${issue.status}`)}</span>
        {issue.customerReported && (
          <span className="badge badge-info">{t("issues.customerLabel")}</span>
        )}
      </div>
      <p className="whitespace-pre-line">{issue.description}</p>
      <p className="text-sm opacity-70">
        {[
          issue.lineName && t("issues.line", { name: issue.lineName }),
          issue.packageNumber !== null && t("issues.package", { number: issue.packageNumber }),
          t("issues.foundIn", { stage: t(`voids.stage.${issue.discoveredStage}`) }),
          issue.originStage &&
            t("issues.startedIn", { stage: t(`voids.stage.${issue.originStage}`) }),
          issue.responsible
            ? t("issues.responsible", { name: issue.responsible.name })
            : t("issues.responsibleNone"),
          issue.reporter && t("issues.reportedBy", { name: issue.reporter.name }),
          issue.noteCount > 0 && t("issues.notes", { count: issue.noteCount }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </article>
  );
}
