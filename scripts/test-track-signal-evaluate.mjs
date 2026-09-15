#!/usr/bin/env npx tsx
/**
 * Unit tests: deterministic track-signal reconcile after mail handoff.
 *
 * Usage: npm run test:track-signal
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  evaluateTrackSignal,
  isOwnerDecisionTrack,
  latestMailHandoff,
  parseMailHandoffs,
  shouldDeferSweepForHandoff,
} from "../src/ea/trackSignalEvaluate.js";

const FINN_HANDOFF_BODY = `
Owner decision: Grade 5 RE volunteer?

mail_handoff:
  message_id: 1a04452c2d45e7fd
  source_path: connectors/mail/gmail/ag_at_example_com/threads/1a04452c2d45e7fd.md
  at: 2026-08-27T17:51:43.042Z
  summary: "Teacher broadcast — if you are receiving this email, I have you down to teach Grade 5 RE."
`;

const VAGUE_HANDOFF_BODY = `
Owner decision: confirm vendor contract

mail_handoff:
  message_id: msg_vague
  source_path: connectors/mail/gmail/ag_at_example_com/threads/msg_vague.md
  at: 2026-09-10T12:00:00.000Z
  summary: "FYI — please review the attached contract when you can."
`;

// parse mail_handoff blocks
{
  const blocks = parseMailHandoffs(FINN_HANDOFF_BODY);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.messageId, "1a04452c2d45e7fd");
  const latest = latestMailHandoff(FINN_HANDOFF_BODY);
  assert.equal(latest?.at, "2026-08-27T17:51:43.042Z");
}

// owner-decision heuristics
{
  assert.equal(
    isOwnerDecisionTrack({
      title: "Owner decision: Grade 5 RE",
      blockReason: "awaiting owner or external party",
    }),
    true,
  );
  assert.equal(
    isOwnerDecisionTrack({
      title: "Follow up with vendor",
      blockReason: "awaiting reply: counterparty",
    }),
    false,
  );
}

// Finn fixture → resolve
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "track-signal-finn-"));
  const filesRoot = path.join(root, "files");
  const mirrorDir = path.join(
    filesRoot,
    "connectors/mail/gmail/ag_at_example_com/threads",
  );
  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.writeFileSync(
    path.join(mirrorDir, "1a04452c2d45e7fd.md"),
    "If you are receiving this email, I have you down to teach or co-teach Grade 5 Religious Education.",
  );

  const verdict = evaluateTrackSignal({
    filesRoot,
    title: "Owner decision: Grade 5 RE volunteer?",
    body: FINN_HANDOFF_BODY,
    blockReason: "awaiting owner or external party",
    status: "blocked",
  });
  assert.equal(verdict.tier, "resolve", JSON.stringify(verdict));
  assert.ok(verdict.evidence.includes("have you down to teach"));

  assert.equal(
    shouldDeferSweepForHandoff({
      filesRoot,
      title: "Owner decision: Grade 5 RE volunteer?",
      body: FINN_HANDOFF_BODY,
      blockReason: "awaiting owner or external party",
    }),
    true,
  );

  fs.rmSync(root, { recursive: true, force: true });
}

// vague handoff → clarify
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "track-signal-clarify-"));
  const filesRoot = path.join(root, "files");
  const verdict = evaluateTrackSignal({
    filesRoot,
    title: "Owner decision: confirm vendor contract",
    body: VAGUE_HANDOFF_BODY,
    blockReason: "awaiting owner approval",
    status: "blocked",
  });
  assert.equal(verdict.tier, "clarify", JSON.stringify(verdict));
  assert.ok(verdict.conflict.includes("still blocked"));
  fs.rmSync(root, { recursive: true, force: true });
}

// no handoff → noop
{
  const verdict = evaluateTrackSignal({
    filesRoot: "/tmp",
    title: "Owner decision: something",
    body: "No handoff here",
    blockReason: "awaiting owner approval",
    status: "blocked",
  });
  assert.equal(verdict.tier, "noop");
  assert.equal(verdict.reason, "no_mail_handoff");
}

// non-owner-input block reason → noop (body must not contain owner-decision heuristics)
{
  const counterpartyBody = `
mail_handoff:
  message_id: m2
  source_path: connectors/mail/gmail/x/threads/m2.md
  at: 2026-08-27T17:51:43.042Z
  summary: "If you are receiving this email, I have you down to teach Grade 5 RE."
`;
  const verdict = evaluateTrackSignal({
    filesRoot: "/tmp",
    title: "Waiting on Courtney",
    body: counterpartyBody,
    blockReason: "awaiting reply: counterparty",
    status: "blocked",
  });
  assert.equal(verdict.tier, "noop");
  assert.equal(verdict.reason, "not_owner_decision_track");
}

console.log("track-signal-evaluate: all tests passed");
