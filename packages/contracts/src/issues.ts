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
};
