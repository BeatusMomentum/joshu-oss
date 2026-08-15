/** Shared owner-reply constants (Kanban child of mail ingress). */

export const EA_OWNER_REPLY_BOARD = "ea-owner-reply";
export const EA_OWNER_REPLY_SKILL = "ea-owner-reply";

export {
  ownerReplyTaskIdempotencyKeyFromMessage,
} from "./mailDedup.js";

export function ownerReplyTaskIdempotencyKey(taskId: string): string {
  return `ea-owner-reply-${taskId}`;
}

/** Create lands ready (assignee set). Never default-block like mail_track. */
export const OWNER_REPLY_DEFAULT_BLOCK_AFTER_CREATE = false;
