/**
 * Inbound agent-mailbox → scoped share-chat answer (Email Q&A lane).
 * Called from EA triage before classifier/ingress when a sender matches
 * an enabled share email binding.
 */

import { readBodyPreview } from "../ea/classifier.js";
import { isFromJoshuAgent } from "../ea/ingestFilters.js";
import { parseEmailAddress } from "../ea/schedulingTypes.js";
import type { AfterMirrorThreadInput } from "../ea/triageTypes.js";
import { buildJoshuSignedEmailHtml } from "../email/joshuEmailSignature.js";
import { getMessage, sendMessage } from "../nylas/client.js";
import { parseMailRecipients } from "../nylas/recipients.js";
import { readAgentGrant } from "../nylas/store.js";
import { resolveJoshuIdentity } from "../joshuIdentity.js";
import { answerShareChatQuestion } from "./answer.js";
import { isShareChatEnabled } from "./chatFlags.js";
import {
  findShareForEmailSender,
  isEmailMessageProcessed,
  markEmailMessageProcessed,
} from "./emailBindings.js";
import { checkShareChatRateLimit } from "./rateLimit.js";
import { queryScopedBrain } from "./scopedBrain.js";
import { resolveShareScope } from "./shareScope.js";

function replySubject(parentSubject: string): string {
  const base = parentSubject.trim();
  if (!base) return "Re: Question";
  if (/^re:/i.test(base)) return base;
  return `Re: ${base}`;
}

/**
 * Attempt a scoped share-chat email reply. Returns true when handled (EA should skip).
 */
export async function tryShareChatEmailIngress(
  input: AfterMirrorThreadInput,
  projectRoot = process.cwd(),
): Promise<boolean> {
  if (input.provider !== "nylas") return false;
  if (isFromJoshuAgent(input.from, projectRoot)) return false;

  const messageId = input.messageId?.trim();
  if (!messageId) return false;

  const sender = parseEmailAddress(input.from);
  if (!sender) return false;

  const binding = findShareForEmailSender(sender, projectRoot);
  if (!binding) return false;

  const shareUuid = binding.shareUuid;
  if (!isShareChatEnabled(shareUuid, projectRoot)) return false;
  if (isEmailMessageProcessed(shareUuid, messageId, projectRoot)) return false;

  const scope = resolveShareScope(shareUuid, projectRoot);
  if (!scope || !scope.valid) return false;

  const rate = checkShareChatRateLimit(`email:${shareUuid}:${sender}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    console.info(`[share-chat/email] rate_limited share=${shareUuid} from=${sender}`);
    return true;
  }

  const agent = readAgentGrant(projectRoot);
  if (!agent?.grantId || !agent.email) {
    console.warn("[share-chat/email] no agent mailbox — skip");
    return false;
  }

  const bodyPreview = await readBodyPreview(input.filesRoot, input.sourcePath);
  const question = bodyPreview.trim();
  if (!question || question.length < 4) {
    console.info(`[share-chat/email] empty question share=${shareUuid} msg=${messageId}`);
    markEmailMessageProcessed(shareUuid, messageId, projectRoot);
    return true;
  }

  try {
    const brain = await queryScopedBrain(question, scope);
    const answered = await answerShareChatQuestion(question, scope, brain.evidence, "email");
    const cite =
      answered.citations.length > 0
        ? `\n\nSources: ${answered.citations.map((c) => c.title).join(", ")}`
        : "";
    const textBody = `${answered.answer}${cite}`.trim() || "I couldn't find that in the shared files.";

    let subject = replySubject(input.subject ?? "");
    try {
      const parent = await getMessage(agent.grantId, messageId);
      if (parent.subject?.trim()) subject = parent.subject.trim();
    } catch {
      /* mirror subject fallback */
    }

    const to = parseMailRecipients(sender, "to");
    const cc = binding.cc.length
      ? parseMailRecipients(binding.cc.join(", "), "cc")
      : undefined;

    const identity = resolveJoshuIdentity(projectRoot);
    const bodyHtml = buildJoshuSignedEmailHtml(textBody, {
      name: identity.name,
      portraitImageUrl: identity.imageUrl ?? undefined,
      ownerDisplayName: identity.owner.displayName,
    });

    await sendMessage(agent.grantId, {
      from: agent.email,
      to,
      cc,
      subject,
      body: bodyHtml,
      replyToMessageId: messageId,
    });

    markEmailMessageProcessed(shareUuid, messageId, projectRoot);
    console.info(
      `[share-chat/email] replied share=${shareUuid} msg=${messageId} from=${sender} evidence=${brain.evidence.length}`,
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[share-chat/email] failed share=${shareUuid} msg=${messageId}: ${msg}`);
    return false;
  }
}
