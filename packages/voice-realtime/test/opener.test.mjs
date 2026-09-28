import assert from "node:assert/strict";
import test from "node:test";

import { buildInboundOpenerTurn, buildOpenerContext } from "../dist/opener.js";
import { detectLanguageMismatch, languageCorrection } from "../dist/languageGuard.js";
import { injectHermesResultUserText } from "../dist/speechPresentation.js";

const cancun = {
  id: "i1",
  kind: "completed",
  title: "Cancun flights",
  text: "Nonstop JFK to CUN on Oct 20: JetBlue 7:05am, $286; Delta 9:40am, $312.",
};

test("inbound opener: one greeting by name, nothing to report", () => {
  const turn = buildInboundOpenerTurn("Dan", []);
  assert.match(turn, /Hi Dan, what can I do for you\?/);
  assert.match(turn, /call no tools/i);
  assert.doesNotMatch(turn, /Cancun/);
});

test("inbound opener offers unheard results by title, without reading them", () => {
  const turn = buildInboundOpenerTurn("Dan", [cancun]);
  assert.match(turn, /“Cancun flights”/);
  assert.match(turn, /Hi Dan — your Cancun flights results are ready\. Want to hear them\?/);
  assert.match(turn, /Do not read the results yet/);
  assert.doesNotMatch(turn, /\$286/);
  const two = buildInboundOpenerTurn("Dan", [cancun, { ...cancun, id: "i2", title: "Oct 25 return" }]);
  assert.match(two, /“Cancun flights” and “Oct 25 return”/);
  assert.match(two, /I have 2 updates ready/);
});

test("unnamed owner gets a plain greeting", () => {
  assert.match(buildInboundOpenerTurn("Owner", []), /"Hi, what can I do for you\?"/);
});

test("opener context carries unheard result text verbatim for the relay", () => {
  const context = buildOpenerContext("inbound", { items: [cancun], context: "- Cancun flights (done)" });
  assert.match(context, /already passed the passphrase check/);
  assert.ok(context.includes(cancun.text));
  assert.match(context, /Background work context/);
  assert.match(buildOpenerContext("callback", undefined), /OUTBOUND call/);
});

test("control turns go to the model exactly as written", () => {
  const turn = buildInboundOpenerTurn("Dan", []);
  assert.equal(injectHermesResultUserText(turn, "voice_only", "control_turn"), turn);
});

test("language guard: flags a Spanish reply to an English owner, ignores short or English replies", () => {
  const spanish = detectLanguageMismatch("Claro, puedo ayudarte con eso. ¿Qué necesitas para el viaje?", "English");
  assert.deepEqual(spanish, { mismatch: true, detected: "spanish" });
  assert.equal(detectLanguageMismatch("Hi Dan — your Cancun flight results are ready. Want them?", "English").mismatch, false);
  assert.equal(detectLanguageMismatch("Sí, claro.", "English").mismatch, false);
  assert.equal(detectLanguageMismatch("The flight is at 7:05 on JetBlue, and it costs $286.", "English").mismatch, false);
  assert.equal(detectLanguageMismatch("Das ist nicht der Flug, den ich für Sie gefunden habe.", "English").detected, "german");
  assert.equal(detectLanguageMismatch("こんにちは、フライトの結果が出ました。", "English").mismatch, true);
  assert.match(languageCorrection("English", "spanish"), /in spanish.*speaks English/i);
});
