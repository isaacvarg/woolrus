import { z } from "zod";
import { base, Id } from "./base";
import {
  FulfillmentStage,
  QualityIssueSeverity,
  QualityIssueType,
  QualityIssueView,
} from "./orders";

// Quality issues (SPEC-exceptions "Quality issue rules"). Like voids, they take no claim and don't
// bump the order's version, so these inputs carry no `expectedVersion`.

const tags = ["Issues"];

export const ISSUE_DESCRIPTION_MAX = 2000;

export const ReportIssueInput = z.object({
  orderId: Id,
  /** A line of this order the issue is about. */
  orderItemId: Id.optional(),
  /** A package of this order the issue is about. */
  packageId: Id.optional(),
  type: QualityIssueType,
  severity: QualityIssueSeverity,
  description: z.string().trim().min(1).max(ISSUE_DESCRIPTION_MAX),
  /** Where the problem started; the stage it was found in comes from the order. */
  originStage: FulfillmentStage.optional(),
  /** Reported by the customer after the fact: Ready and Completed orders only. */
  customerReported: z.boolean().default(false),
});
export type ReportIssueInput = z.input<typeof ReportIssueInput>;

export const UpdateIssueInput = z.object({
  issueId: Id,
  type: QualityIssueType.optional(),
  severity: QualityIssueSeverity.optional(),
  description: z.string().trim().min(1).max(ISSUE_DESCRIPTION_MAX).optional(),
  /** `null` clears the origin stage. */
  originStage: FulfillmentStage.nullable().optional(),
  orderItemId: Id.nullable().optional(),
  packageId: Id.nullable().optional(),
});
export type UpdateIssueInput = z.input<typeof UpdateIssueInput>;

export const SetResponsibleInput = z.object({ issueId: Id, userId: Id.nullable() });
export type SetResponsibleInput = z.infer<typeof SetResponsibleInput>;

export const ISSUE_NOTES_MAX = 1000;

export const ResolveIssueInput = z.object({
  issueId: Id,
  outcome: z.enum(["RESOLVED", "DISMISSED"]),
  notes: z.string().trim().min(1).max(ISSUE_NOTES_MAX),
});
export type ResolveIssueInput = z.infer<typeof ResolveIssueInput>;

export const ReopenIssueInput = z.object({ issueId: Id });
export type ReopenIssueInput = z.infer<typeof ReopenIssueInput>;

export const IssueListStatus = z.enum(["all", "open", "resolved"]);
export type IssueListStatus = z.infer<typeof IssueListStatus>;

export const IssueListInput = z.object({
  /** `resolved` includes dismissed. */
  status: IssueListStatus.default("all"),
  severity: QualityIssueSeverity.optional(),
  type: QualityIssueType.optional(),
  orderId: Id.optional(),
  /** Order-number prefix or part of the customer's name. */
  search: z.string().trim().max(100).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type IssueListInput = z.input<typeof IssueListInput>;

/** A row of the Issues page: the issue plus where it is. */
export const IssueRow = QualityIssueView.extend({
  orderNumber: z.string(),
  customerName: z.string(),
});
export type IssueRow = z.infer<typeof IssueRow>;

export const IssueListPage = z.object({
  rows: z.array(IssueRow),
  nextCursor: z.string().nullable(),
});
export type IssueListPage = z.infer<typeof IssueListPage>;

export const GetIssueInput = z.object({ issueId: Id });
export type GetIssueInput = z.infer<typeof GetIssueInput>;

/** For the nav badge: open issues, and whether any is Critical. */
export const IssueCounts = z.object({ open: z.number().int(), openCritical: z.number().int() });
export type IssueCounts = z.infer<typeof IssueCounts>;

/** An active user who can be named responsible. */
export const IssueAssignee = z.object({ id: Id, name: z.string() });
export type IssueAssignee = z.infer<typeof IssueAssignee>;

export const issues = {
  report: base
    .route({
      method: "POST",
      path: "/orders/{orderId}/issues",
      tags,
      summary: "Report a quality issue on an order, a line or a package",
    })
    .input(ReportIssueInput)
    .output(QualityIssueView),
  update: base
    .route({ method: "PATCH", path: "/issues/{issueId}", tags, summary: "Edit an open issue" })
    .input(UpdateIssueInput)
    .output(QualityIssueView),
  setResponsible: base
    .route({
      method: "POST",
      path: "/issues/{issueId}/responsible",
      tags,
      summary: "Change who is responsible for an issue",
    })
    .input(SetResponsibleInput)
    .output(QualityIssueView),
  resolve: base
    .route({
      method: "POST",
      path: "/issues/{issueId}/resolve",
      tags,
      summary: "Resolve or dismiss an open issue with a note",
    })
    .input(ResolveIssueInput)
    .output(QualityIssueView),
  reopen: base
    .route({ method: "POST", path: "/issues/{issueId}/reopen", tags, summary: "Reopen an issue" })
    .input(ReopenIssueInput)
    .output(QualityIssueView),
  list: base
    .route({ method: "GET", path: "/issues", tags, summary: "Quality issues, open Critical first" })
    .input(IssueListInput)
    .output(IssueListPage),
  counts: base
    .route({ method: "GET", path: "/issues/counts", tags, summary: "Open issue counts" })
    .output(IssueCounts),
  get: base
    .route({ method: "GET", path: "/issues/{issueId}", tags, summary: "One quality issue" })
    .input(GetIssueInput)
    .output(IssueRow),
  assignees: base
    .route({
      method: "GET",
      path: "/issues/assignees",
      tags,
      summary: "Active users who can be made responsible",
    })
    .output(z.array(IssueAssignee)),
};
