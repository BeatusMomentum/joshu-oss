import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildThinkUserMessage,
  resolveThinkUserQuote,
} from "../dist/brainThink.js";

describe("resolveThinkUserQuote", () => {
  it("returns the first non-empty trimmed candidate", () => {
    assert.equal(resolveThinkUserQuote("  hello  ", "ignored"), "hello");
    assert.equal(resolveThinkUserQuote("", "  pending  "), "pending");
    assert.equal(resolveThinkUserQuote(undefined, null, "stt"), "stt");
    assert.equal(resolveThinkUserQuote(undefined, "  "), undefined);
  });
});

describe("buildThinkUserMessage", () => {
  it("includes User said when a quote is present", () => {
    const msg = buildThinkUserMessage({
      intent: "read_journal",
      summary: 'User asked for lowest hanging fruit',
      userQuote: "what's the lowest hanging fruit?",
    });
    assert.equal(
      msg,
      [
        "Intent: read_journal",
        "Conversation summary: User asked for lowest hanging fruit",
        "User said: what's the lowest hanging fruit?",
      ].join("\n"),
    );
  });

  it("omits User said when no quote (Realtime paraphrase only)", () => {
    const msg = buildThinkUserMessage({
      intent: "read_journal",
      summary: "User asked for prioritization guidance",
    });
    assert.equal(
      msg,
      [
        "Intent: read_journal",
        "Conversation summary: User asked for prioritization guidance",
      ].join("\n"),
    );
    assert.ok(!msg.includes("User said:"));
  });
});
