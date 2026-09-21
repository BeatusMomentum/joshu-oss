/**
 * Back-compat re-exports — prefer router.ts for new code.
 */
export {
  classifyRealtimeGoalMessage,
  isExplicitCancelPhrase,
  routeRealtimeGoalMessage,
  type RealtimeGoalAdmission,
  type RealtimeGoalRouteDecision,
  type RouteRealtimeGoalMessageInput,
  type RouteRealtimeGoalMessageOptions,
} from "./router.js";
