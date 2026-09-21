import type { RealtimeGoalChannel } from "./types.js";

/** Whether the broker may auto-queue, clarify, ack, update, cancel, or status-route. */
export function isQueueCapableChannel(channel: RealtimeGoalChannel): boolean {
  switch (channel) {
    case "sms":
    case "pstn_voice":
    case "browser_voice":
    case "slack":
    case "telegram":
      return true;
    case "jchat":
    case "agui":
      return false;
    default:
      return false;
  }
}

/** Whether Hermes may call realtime_goal_defer for this channel. */
export function isDeferCapableChannel(channel: RealtimeGoalChannel): boolean {
  return isQueueCapableChannel(channel);
}

/** Whether we maintain a session thread for routing context. */
export function usesSessionThread(channel: RealtimeGoalChannel): boolean {
  switch (channel) {
    case "sms":
    case "pstn_voice":
    case "browser_voice":
    case "slack":
    case "telegram":
    case "jchat":
    case "agui":
      return true;
    default:
      return false;
  }
}
