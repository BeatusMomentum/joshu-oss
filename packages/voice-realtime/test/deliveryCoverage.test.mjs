import assert from "node:assert/strict";
import test from "node:test";

import { keyTokens, spokenCoverage, spokenCovers } from "../dist/deliveryCoverage.js";
import { buildVoiceSystemPrompt, resolveJoshuIdentity } from "../dist/joshuIdentity.js";

// Results and what the model actually said on the canary box, 2026-09-26.
const CANCUN_RESULT = [
  "LAX to Cancun (CUN), round trip, 1 adult, economy.",
  "I priced Dec 20 to Dec 27 as the Christmas window.",
  "Cheapest nonstop both ways - Delta, $838 total:",
  "Out: Sun Dec 20, LAX 11:26 PM to CUN 7:05 AM Mon Dec 21, 4h 39m nonstop.",
  "Back: Sun Dec 27, CUN 8:20 AM to LAX 10:46 AM, 5h 26m nonstop.",
  "Other nonstops out of LAX on Dec 20:",
  "- Delta 10:23 AM to 6:00 PM, $940",
].join("\n");
const CANCUN_SPOKEN =
  "I'm calling about the flights you asked me to check. The cheapest nonstop both ways is 838 dollars total with Delta, " +
  "departing on December 20th and returning on December 27th. Other nonstop options on December 20th include Delta for " +
  "940 dollars, United for 971 dollars, and American for 1128 dollars.";

const OCT20_RESULT = [
  "Flight options, LAX to JFK, Tuesday Oct 20.",
  "One adult, economy.",
  "Cheapest nonstop - $204:",
  "- Delta 7:40 AM - 4:01 PM (5h 21m)",
  "- Delta 8:40 AM - 5:09 PM (5h 29m)",
  "- JetBlue 9:30 AM - 6:00 PM (5h 30m)",
].join("\n");
// Relayed from the background context on an inbound call, not from an inject.
const OCT20_SPOKEN =
  "I have the options for LAX to JFK on Tuesday, October 20th. The cheapest nonstop is 204 dollars on Delta and JetBlue, " +
  "with Delta flights starting at 7:40 AM and JetBlue at 9:30 AM.";

test("a callback relayed in the model's own turn still counts as heard (Cancun duplicate call)", () => {
  assert.ok(spokenCovers(CANCUN_RESULT, CANCUN_SPOKEN));
});

test("a result relayed from context counts as heard (Oct 20 stayed 'parked')", () => {
  assert.ok(spokenCovers(OCT20_RESULT, OCT20_SPOKEN));
});

test("a greeting or a different result is not coverage", () => {
  assert.equal(spokenCovers(CANCUN_RESULT, "Hi Dan, how can I help you today?"), false);
  assert.equal(spokenCovers(CANCUN_RESULT, OCT20_SPOKEN), false);
  assert.ok(spokenCoverage(OCT20_RESULT, "I'll look into those flight options for you.") < 0.5);
});

test("years and thousands separators are normalized", () => {
  assert.deepEqual(keyTokens("Sunday Oct 25, 2026: $1,128 on American").tokens.includes("2026"), false);
  assert.ok(spokenCovers("Total $1,128 on Oct 25 at 10:46", "It's 1128 dollars on the 25th at 10:46."));
});

test("results without numbers fall back to names", () => {
  const result = "Emailed you the RapidAPI login link. Open it and go to Billing, then Subscriptions.";
  assert.equal(keyTokens(result).kind, "words");
  assert.ok(spokenCovers(result, "I emailed you the RapidAPI link — sign in and head to Billing, then Subscriptions."));
  assert.equal(spokenCovers(result, "Sure, one moment."), false);
});

test("voice prompts pin the owner's language (Spanish reply 2026-09-26)", () => {
  const identity = resolveJoshuIdentity();
  for (const prompt of [
    buildVoiceSystemPrompt(identity, "phone", { nativeAsyncTools: true }),
    buildVoiceSystemPrompt(identity, "web", { nativeAsyncTools: true }),
    buildVoiceSystemPrompt(identity, "phone"),
    buildVoiceSystemPrompt(identity, "web"),
  ]) {
    assert.match(prompt, /RESPOND IN ENGLISH\. YOU MUST RESPOND UNMISTAKABLY IN ENGLISH\./);
  }
});
