/**
 * Handle inbound Bot Framework activities for Teams Share Chat Q&A.
 */

import { resolveShareScope } from "./shareScope.js";
import { isShareChatEnabled } from "./chatFlags.js";
import { queryScopedBrain } from "./scopedBrain.js";
import { answerShareChatQuestion } from "./answer.js";
import { checkShareChatRateLimit } from "./rateLimit.js";
import {
  getShareUuidForTeamsConversation,
  upsertTeamsConversationBinding,
} from "./teamsConversations.js";
import {
  sendTeamsBotReply,
  type BotActivity,
  verifyTeamsBotAuthHeader,
} from "./teamsBotAuth.js";
import { resolveTeamsBotCreds } from "./teamsBotCreds.js";
import {
  extractShareUuidFromTeamsText,
  isTeamsBindCommand,
  stripTeamsMentions,
} from "./teamsBotParse.js";

function botIdFromRecipient(activity: BotActivity, appId: string): string {
  const rid = activity.recipient?.id || "";
  // Teams recipient ids look like "28:appId"
  if (rid.includes(appId)) return rid;
  return `28:${appId}`;
}

function isFromBot(activity: BotActivity, appId: string): boolean {
  const fromId = activity.from?.id || "";
  if (!fromId) return false;
  if (fromId === activity.recipient?.id) return true;
  if (fromId.includes(appId)) return true;
  // ChannelData may mark bot messages
  const cd = activity.channelData || {};
  if (cd.fromBot || cd.botMessage) return true;
  return false;
}

async function reply(
  activity: BotActivity,
  text: string,
  projectRoot: string,
): Promise<void> {
  const serviceUrl = activity.serviceUrl?.trim();
  const conversationId = activity.conversation?.id?.trim();
  if (!serviceUrl || !conversationId) return;
  await sendTeamsBotReply({
    serviceUrl,
    conversationId,
    text: text.slice(0, 4000),
    replyToId: activity.id,
    projectRoot,
  });
}

/**
 * Process one inbound activity. Always resolves (errors become chat replies when possible).
 */
export async function handleTeamsBotActivity(
  activity: BotActivity,
  projectRoot = process.cwd(),
): Promise<{ ok: boolean; ignored?: string; error?: string }> {
  const creds = resolveTeamsBotCreds(projectRoot);
  if (!creds) return { ok: false, error: "teams_bot_not_configured" };

  const type = String(activity.type || "");
  if (type === "conversationUpdate") {
    // Welcome when bot is added
    const members = activity.membersAdded || [];
    const botRef = botIdFromRecipient(activity, creds.appId);
    const addedBot = members.some((m) => m.id === botRef || m.id?.includes(creds.appId));
    if (addedBot) {
      await reply(
        activity,
        [
          "Hi — I'm Joshu Share Chat.",
          "Bind me to a shared file set by sending:",
          "`bind <share-uuid>`",
          "or paste the public Share Chat link.",
          "Then ask questions about those files (in group chats, @mention me).",
        ].join("\n"),
        projectRoot,
      );
    }
    return { ok: true, ignored: "conversationUpdate" };
  }

  if (type !== "message") {
    return { ok: true, ignored: `type:${type || "unknown"}` };
  }

  if (isFromBot(activity, creds.appId)) {
    return { ok: true, ignored: "bot_message" };
  }

  const conversationId = activity.conversation?.id?.trim();
  if (!conversationId) return { ok: true, ignored: "no_conversation" };

  const text = stripTeamsMentions(String(activity.text || ""));
  if (!text) return { ok: true, ignored: "empty" };

  // Bind / re-bind this conversation to a share UUID
  if (isTeamsBindCommand(text) || extractShareUuidFromTeamsText(text)) {
    const shareUuid = extractShareUuidFromTeamsText(text);
    if (!shareUuid) {
      await reply(
        activity,
        "I couldn't find a share UUID. Send `bind <uuid>` or paste the Share Chat URL.",
        projectRoot,
      );
      return { ok: true, ignored: "bind_missing_uuid" };
    }
    if (!isShareChatEnabled(shareUuid, projectRoot)) {
      await reply(activity, "That share is not available for chat (disabled or missing).", projectRoot);
      return { ok: true, ignored: "chat_disabled" };
    }
    const scope = resolveShareScope(shareUuid, projectRoot);
    if (!scope || !scope.valid) {
      await reply(activity, "That share UUID is invalid or no longer shared.", projectRoot);
      return { ok: true, ignored: "share_invalid" };
    }
    upsertTeamsConversationBinding(
      {
        shareUuid,
        conversationId,
        conversationType: activity.conversation?.conversationType,
        serviceUrl: activity.serviceUrl,
        tenantId: activity.conversation?.tenantId,
      },
      projectRoot,
    );
    await reply(
      activity,
      `Bound to **${scope.displayName}**. Ask me questions about those files. In group chats, @mention me.`,
      projectRoot,
    );
    return { ok: true };
  }

  const shareUuid = getShareUuidForTeamsConversation(conversationId, projectRoot);
  if (!shareUuid) {
    await reply(
      activity,
      "This chat is not bound to a file share yet. Send `bind <share-uuid>` or paste the Share Chat URL first.",
      projectRoot,
    );
    return { ok: true, ignored: "unbound" };
  }

  const rate = checkShareChatRateLimit(`teams:${shareUuid}:${conversationId}`, {
    limit: 20,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    await reply(activity, "Too many questions — try again in a minute.", projectRoot);
    return { ok: true, ignored: "rate_limited" };
  }

  if (!isShareChatEnabled(shareUuid, projectRoot)) {
    await reply(activity, "Chat sharing is off for this file set.", projectRoot);
    return { ok: true, ignored: "chat_disabled" };
  }
  const scope = resolveShareScope(shareUuid, projectRoot);
  if (!scope || !scope.valid) {
    await reply(activity, "The shared files are no longer available.", projectRoot);
    return { ok: true, ignored: "share_invalid" };
  }

  try {
    const brain = await queryScopedBrain(text, scope);
    const answered = await answerShareChatQuestion(text, scope, brain.evidence, "teams");
    const cite =
      answered.citations.length > 0
        ? `\n\n_Sources: ${answered.citations.map((c) => c.title).join(", ")}_`
        : "";
    const msg = `${answered.answer}${cite}`.trim() || "I couldn't find that in the shared files.";
    await reply(activity, msg, projectRoot);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[share-chat/teams-bot]", msg);
    try {
      await reply(
        activity,
        "Sorry — I hit an error answering from the shared files. Try again in a moment.",
        projectRoot,
      );
    } catch {
      /* ignore */
    }
    return { ok: false, error: msg };
  }
}

/** Express-facing entry: verify auth then handle activity JSON. */
export async function handleTeamsBotMessagesRequest(opts: {
  authHeader: string | undefined;
  body: unknown;
  projectRoot?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectRoot = opts.projectRoot || process.cwd();
  const creds = resolveTeamsBotCreds(projectRoot);
  if (!creds) {
    return { status: 503, body: { error: "teams_bot_not_configured" } };
  }

  const okAuth = await verifyTeamsBotAuthHeader(opts.authHeader, creds);
  if (!okAuth) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  const activity = (opts.body && typeof opts.body === "object" ? opts.body : {}) as BotActivity;
  // Acknowledge immediately-ish; processing is sync for MVP (same as Slack path).
  const result = await handleTeamsBotActivity(activity, projectRoot);
  if (!result.ok && result.error === "teams_bot_not_configured") {
    return { status: 503, body: { error: result.error } };
  }
  return { status: 200, body: { ok: result.ok !== false, ignored: result.ignored, error: result.error } };
}
