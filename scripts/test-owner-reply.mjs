#!/usr/bin/env npx tsx
/**
 * Unit tests: owner-reply eligibility, ready-create contract, thread dedup, ingress body flag.
 *
 * Usage: npm run test:owner-reply
 */
import assert from "node:assert/strict";
import { isOwnerReplyEligible, ownerReplyIngressPlaybookLines } from "../src/ea/ownerReplyEligibility.js";
import {
  buildOwnerReplyTaskBody,
  findOpenOwnerReplyByThread,
} from "../src/ea/ownerReplyCron.js";
import {
  OWNER_REPLY_DEFAULT_BLOCK_AFTER_CREATE,
  ownerReplyTaskIdempotencyKeyFromMessage,
} from "../src/ea/ownerReplyTypes.js";
import { buildMailIngressTaskBody } from "../src/ea/mailCron.js";

const owner = "goodrich@graymediagroup.com";
const owners = [owner, "ag@andrewgoodrich.com"];

{
  const ok = isOwnerReplyEligible({
    provider: "nylas",
    from: `Andrew <${owner}>`,
    ownerEmails: owners,
    disposition: "track",
    category: "project_work",
    schedulingPathA: false,
  });
  assert.equal(ok.eligible, true);
  assert.equal(ok.reason, "owner_ask_agent");
}

{
  const no = isOwnerReplyEligible({
    provider: "gmail",
    from: `Andrew <${owner}>`,
    ownerEmails: owners,
    disposition: "track",
  });
  assert.equal(no.eligible, false);
  assert.equal(no.reason, "not_agent_inbox");
}

{
  const no = isOwnerReplyEligible({
    provider: "nylas",
    from: "Counterparty <ext@example.com>",
    ownerEmails: owners,
    disposition: "track",
  });
  assert.equal(no.eligible, false);
  assert.equal(no.reason, "not_from_owner");
}

{
  const no = isOwnerReplyEligible({
    provider: "nylas",
    from: owner,
    ownerEmails: owners,
    disposition: "track",
    schedulingPathA: true,
  });
  assert.equal(no.eligible, false);
  assert.equal(no.reason, "scheduling_path_a");
}

{
  const no = isOwnerReplyEligible({
    provider: "nylas",
    from: owner,
    ownerEmails: owners,
    disposition: "info",
  });
  assert.equal(no.eligible, false);
  assert.equal(no.reason, "disposition_not_track");
}

{
  const no = isOwnerReplyEligible({
    provider: "nylas",
    from: owner,
    ownerEmails: owners,
    category: "owner_sent_update",
  });
  assert.equal(no.eligible, false);
  assert.equal(no.reason, "owner_sent_update");
}

assert.equal(OWNER_REPLY_DEFAULT_BLOCK_AFTER_CREATE, false);
const taskBody = buildOwnerReplyTaskBody({
  subject: "MCP report",
  fromEmail: owner,
  sourcePath: "connectors/mail/nylas/threads/abc.md",
  messageId: "msg-1",
  threadId: "thread-abc",
  provider: "nylas",
});
assert.match(taskBody, /^kind: owner_reply$/m);
assert.match(taskBody, /^thread_id: thread-abc$/m);
assert.doesNotMatch(taskBody, /awaiting owner or external party/);

const meetKey = ownerReplyTaskIdempotencyKeyFromMessage("msg-1");
assert.match(meetKey, /^ea-owner-reply-msg-/);

{
  const tasks = [
    {
      task_id: "t_open",
      status: "ready",
      body: "kind: owner_reply\nthread_id: thread-abc\nsource_paths:\n  - connectors/mail/nylas/threads/thread-abc.md",
    },
    {
      task_id: "t_other",
      status: "ready",
      body: "kind: owner_reply\nthread_id: other-thread",
    },
  ];
  const hit = findOpenOwnerReplyByThread(tasks, "thread-abc");
  assert.equal(hit?.task_id, "t_open");
  const miss = findOpenOwnerReplyByThread(tasks, "no-such");
  assert.equal(miss, undefined);
}

process.env.JOSHU_AROZ_USER = owner;
const ingressBody = buildMailIngressTaskBody(
  {
    filesRoot: "/tmp",
    provider: "nylas",
    threadId: "thread-abc",
    sourcePath: "connectors/mail/nylas/threads/thread-abc.md",
    from: `Andrew <${owner}>`,
    messageId: "msg-1",
    classification: {
      category: "project_work",
      project_slug: "hermes-mcp-research",
      is_new_track: true,
      reason: "test",
      scheduling_hint: false,
      authorization: {
        agent_authorized: true,
        scheduling_eligible: false,
        reason: "agent_on_recipients",
      },
    },
  },
  null,
  "finn@joshu.me",
);
assert.match(ingressBody, /owner_reply_eligible: true/);
assert.match(ingressBody, /allowed_actions: file,reply/);
assert.match(ingressBody, /owner_reply_list_tasks/);
assert.match(ingressBody, /Path D spawn only/);
assert.match(ingressBody, /do not research or nylas_send_message on ea-mail-ingress/);

const skipLines = ownerReplyIngressPlaybookLines(false);
assert.equal(skipLines.length, 0);

const gmailIngress = buildMailIngressTaskBody(
  {
    filesRoot: "/tmp",
    provider: "gmail",
    threadId: "g1",
    sourcePath: "connectors/mail/gmail/work/threads/g1.md",
    from: `Andrew <${owner}>`,
    accountEmail: owner,
    messageId: "g-msg",
    classification: {
      category: "project_work",
      project_slug: "other",
      is_new_track: true,
      reason: "test",
      scheduling_hint: false,
      authorization: {
        agent_authorized: false,
        scheduling_eligible: false,
        reason: "not_copied_or_delegated",
      },
    },
  },
  null,
  "finn@joshu.me",
);
assert.match(gmailIngress, /owner_reply_eligible: false/);
assert.doesNotMatch(gmailIngress, /owner_reply_list_tasks/);

console.log("owner-reply unit tests ok");
