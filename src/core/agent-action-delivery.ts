import type {
  AgentActionControlDeliveryContext,
  AgentActionControlDeliveryResult,
  AgentActionControlResponse,
} from "./types.js";

/** Deliver bounded standalone parts while preserving the immutable routing lease. */
export async function deliverAgentActionControlParts(
  response: AgentActionControlResponse,
  parts: readonly string[],
  context: AgentActionControlDeliveryContext,
  deliverPart: (part: string, index: number) => Promise<void | "stale">,
): Promise<AgentActionControlDeliveryResult> {
  let deliveredParts = 0;
  const totalParts = parts.length;
  for (let index = 0; index < parts.length; index += 1) {
    if (!context.isCurrent()) {
      return {
        type: "agent_action_control_delivery",
        action: response.action,
        status: deliveredParts > 0 ? "partial" : "dropped",
        deliveredParts,
        totalParts,
        reason: "stale-target",
      };
    }
    try {
      const outcome = await deliverPart(parts[index]!, index);
      if (outcome === "stale") {
        return {
          type: "agent_action_control_delivery",
          action: response.action,
          status: deliveredParts > 0 ? "partial" : "dropped",
          deliveredParts,
          totalParts,
          reason: "stale-target",
        };
      }
      deliveredParts += 1;
    } catch {
      return {
        type: "agent_action_control_delivery",
        action: response.action,
        status: deliveredParts > 0 ? "partial" : "failed",
        deliveredParts,
        totalParts,
        reason: "connector-error",
      };
    }
    if (!context.isCurrent()) {
      if (deliveredParts === totalParts) {
        return {
          type: "agent_action_control_delivery",
          action: response.action,
          status: "completed",
          deliveredParts,
          totalParts,
        };
      }
      return {
        type: "agent_action_control_delivery",
        action: response.action,
        status: "partial",
        deliveredParts,
        totalParts,
        reason: "stale-target",
      };
    }
  }
  return {
    type: "agent_action_control_delivery",
    action: response.action,
    status: "completed",
    deliveredParts,
    totalParts,
  };
}
