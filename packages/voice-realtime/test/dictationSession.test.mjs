import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendDictationChunk,
  buildDictationThinkMessage,
  createDictationSession,
  looksLikeDictationDone,
  looksLikeExplicitDictationStart,
  parseDictationFormat,
  recentUserSpeechLooksLikeDictationStart,
} from "../dist/dictationSession.js";

describe("dictationSession", () => {
  it("parses format aliases", () => {
    assert.equal(parseDictationFormat("cleanup"), "cleanup");
    assert.equal(parseDictationFormat("list"), "cleanup");
    assert.equal(parseDictationFormat("reformulate"), "reformulate");
    assert.equal(parseDictationFormat("meeting"), "reformulate");
    assert.equal(parseDictationFormat("auto"), "auto");
    assert.equal(parseDictationFormat(""), "auto");
  });

  it("buffers chunks and skips done phrases from content", () => {
    let s = createDictationSession({ destination: "Websites.md", format: "cleanup" });
    s = appendDictationChunk(s, "orchid.ai");
    s = appendDictationChunk(s, "type.com");
    s = appendDictationChunk(s, "that's it for now");
    assert.deepEqual(s.chunks, ["orchid.ai", "type.com"]);
    assert.equal(looksLikeDictationDone("that's it for now"), true);
    assert.equal(looksLikeDictationDone("that's the next one"), false);
  });

  it("builds think message with full buffer and format guidance", () => {
    let s = createDictationSession({
      destination: "Meeting notes.md",
      format: "reformulate",
      title: "Standup",
    });
    s = appendDictationChunk(s, "um we talked about shipping voice");
    s = appendDictationChunk(s, "and then hiring for the EA role");
    const msg = buildDictationThinkMessage(s);
    assert.equal(msg.intent, "finish_dictation");
    assert.match(msg.summary, /REFORMULATE/);
    assert.match(msg.summary, /Meeting notes\.md/);
    assert.match(msg.userQuote, /shipping voice/);
    assert.match(msg.userQuote, /EA role/);
  });

  it("requires an explicit wait-until-done dump cue to start dictation", () => {
    assert.equal(
      looksLikeExplicitDictationStart(
        "I am about to tell you a bunch of things so just wait for me to finish.",
      ),
      true,
    );
    assert.equal(looksLikeExplicitDictationStart("just wait for me to finish"), true);
    assert.equal(looksLikeExplicitDictationStart("don't interrupt, I have a list"), true);
    assert.equal(looksLikeExplicitDictationStart("start dictation"), true);
    assert.equal(looksLikeExplicitDictationStart("take this down"), true);
    assert.equal(looksLikeExplicitDictationStart("I'm going to list a bunch of sites, just listen"), true);
    assert.equal(
      looksLikeExplicitDictationStart("I'm going to give you some calendar reminders"),
      false,
    );
    assert.equal(
      looksLikeExplicitDictationStart("I want to give you some calendar reminders"),
      false,
    );
    assert.equal(looksLikeExplicitDictationStart("what's on my calendar"), false);
    assert.equal(looksLikeExplicitDictationStart("I have a bunch of meetings tomorrow"), false);
    assert.equal(looksLikeExplicitDictationStart("make a list of the websites we talked about"), false);
    assert.equal(looksLikeExplicitDictationStart("write this down: buy milk"), false);
    assert.equal(
      recentUserSpeechLooksLikeDictationStart([
        "I want to give you some calendar reminders",
      ]),
      false,
    );
    assert.equal(
      recentUserSpeechLooksLikeDictationStart([
        "I want to give you some calendar reminders",
        "actually wait until I'm done, I have a bunch of things",
      ]),
      true,
    );
  });
});
