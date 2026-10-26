import type { FulfillmentStage, Order } from "@woolrus/db";

/**
 * The stage an action happened in, from the order's status (SPEC-exceptions "Vocabulary"). Stored
 * on voids and quality issues; the actor never types it. A held order is where it was held from.
 */
export function stageFor(order: Pick<Order, "status" | "heldFromStatus">): FulfillmentStage {
  const status = order.status === "ON_HOLD" ? order.heldFromStatus : order.status;
  switch (status) {
    case "PICKING":
      return "PICKING";
    case "PACKING":
      return "PACKING";
    case "QA":
      return "QA";
    case "READY":
      return "SHIPPING";
    case "COMPLETED":
      return "CUSTOMER";
    default:
      return "INTAKE";
  }
}
