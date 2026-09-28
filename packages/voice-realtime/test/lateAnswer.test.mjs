import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import test, { after, beforeEach } from "node:test";

/**
 * Fake Joshu jobs API. `plan.start` decides what POST /jobs answers; a job
 * listed in `plan.lateAnswers` resolves on the next GET wait.
 */
const plan = { start: "working", lateAnswers: new Map(), delivered: [] };
const requests = [];
const joshu = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: url.pathname, body: body ? JSON.parse(body) : undefined });
    res.writeHead(200, { "Content-Type": "application/json" });
    const reply = (value) => res.end(JSON.stringify(value));
    const jobId = url.pathname.split("/")[5];
    if (req.method === "POST" && url.pathname === "/joshu/api/realtime-goals/jobs") {
      if (plan.start === "done") {
        return reply({ jobId: "job-fast", status: "done", source: "hermes", answer: "Dentist at 3:15 PM.", delivered: plan.delivered });
      }
      return reply({ jobId: "job-late", status: "running", delivered: [] });
    }
    if (req.method === "GET" && jobId) {
      const answer = plan.lateAnswers.get(jobId);
      return reply(answer ? { jobId, status: "done", source: "hermes", answer, delivered: [] } : { jobId, status: "running", delivered: [] });
    }
    if (url.pathname.endsWith("/claim")) {
      return reply({ claimed: true, jobId, status: "done", source: "hermes", answer: plan.lateAnswers.get(jobId), delivered: [] });
    }
    if (url.pathname.endsWith("/detach")) return reply({ jobId, status: "running", delivered: [] });
    if (url.pathname.endsWith("/voice/opener")) return reply({ items: [] });
    return reply({ items: [] });
  });
});
joshu.listen(0, "127.0.0.1");
await once(joshu, "listening");

Object.assign(process.env, {
  JOSHU_VOICE_PROVIDER: "gemini_live",
  GEMINI_LIVE_MODEL: "gemini-3.8-live-extended-thinking",
  GEMINI_API_KEY: "test",
  HERMES_API_KEY: "svc",
  JOSHU_API_BASE_URL: `http://127.0.0.1:${joshu.address().port}/joshu`,
});

const { GeminiLiveClient } = await import("../dist/geminiLiveClient.js");
const { TwilioRealtimeSession } = await import("../dist/twilioRealtimeSession.js");
const { runNativeVoiceTool } = await import("../dist/nativeToolRunner.js");
const { claimCorrection, detectDeliveryClaim } = await import("../dist/deliveryClaimGuard.js");
const { injectHermesResultUserText } = await import("../dist/speechPresentation.js");

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(msg) {
    this.sent.push(JSON.parse(msg));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  server(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}
const geminiSockets = [];
GeminiLiveClient.prototype.createSocket = function createSocket() {
  const socket = new FakeSocket();
  geminiSockets.push(socket);
  return socket;
};

async function waitFor(predicate, label) {
  for (let i = 0; i < 300; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

beforeEach(() => {
  plan.start = "working";
  plan.lateAnswers.clear();
  plan.delivered = [];
  requests.length = 0;
});
after(() => joshu.close());

const think = (callSid) => ({
  kind: "think",
  think: { callSid, jobId: "j1", intent: "calendar", summary: "dentist", userQuote: "When's my dentist?", presentation: "phone" },
});

test("delivery claims: detected in speech, corrected unless a send backs them", () => {
  assert.equal(detectDeliveryClaim("I've texted you the link."), "texted");
  assert.equal(detectDeliveryClaim("The link has been texted to you."), "texted");
  assert.equal(detectDeliveryClaim("I just sent it over."), "sent");
  assert.equal(detectDeliveryClaim("You'll get a text with the details shortly."), "text");
  assert.equal(detectDeliveryClaim("Let me check your calendar."), undefined);
  assert.equal(detectDeliveryClaim("I'll text you the link once it's ready."), undefined, "a promise is not a claim");
  assert.match(claimCorrection(["texted"], "Dentist at 3:15 PM.", []), /nothing was sent/);
  assert.equal(claimCorrection(["texted"], "Dentist at 3:15 PM.", [{ what: "link", via: "sms", ok: true, at: "" }]), undefined);
  assert.equal(claimCorrection(["emailed"], "I emailed you the itinerary.", []), undefined, "the answer reports its own send");
  assert.equal(claimCorrection([], "x", []), undefined);
});

test("phone think within budget: done result lists what was sent", async () => {
  plan.start = "done";
  const outcome = await runNativeVoiceTool(think("CA-r1"));
  assert.equal(outcome.jobId, "job-fast");
  assert.equal(outcome.result.status, "done");
  assert.equal(outcome.result.answer, "Dentist at 3:15 PM.");
  assert.deepEqual(outcome.result.delivered, []);
  assert.match(outcome.result.instruction, /Nothing was texted, emailed, or sent/);
  const start = requests.find((r) => r.method === "POST");
  assert.equal(start.body.budgetMs, 10_000);
  assert.equal(start.body.origin.channel, "pstn_voice");
  assert.equal(start.body.hermesSessionKey, "joshu-hermes-chat:CA-r1");
});

test("phone think past budget: 'still working', never a guess", async () => {
  const outcome = await runNativeVoiceTool(think("CA-r2"));
  assert.equal(outcome.pending, true);
  assert.equal(outcome.result.status, "working");
  assert.match(outcome.result.instruction, /still working/);
  assert.match(outcome.result.instruction, /Do not guess/);
});

test("late answer: spoken when it lands, with a correction for an early 'I texted it'", async () => {
  const twilio = new FakeSocket();
  const session = new TwilioRealtimeSession(twilio);
  session.handleStart("CA-late-1", "MZ-1", { gate: { mode: "inbound", via: "trusted" } });
  const gemini = geminiSockets.at(-1);
  gemini.emit("open");
  gemini.server({ setupComplete: {} });
  await waitFor(() => gemini.sent.some((msg) => msg.clientContent?.turnComplete === true), "opener");
  gemini.server({ serverContent: { outputTranscription: { text: "Hi, what can I do for you?" } } });
  gemini.server({ serverContent: { turnComplete: true } });

  gemini.server({ toolCall: { functionCalls: [{ id: "call-1", name: "think", args: { user_quote: "When's my dentist?" } }] } });
  await waitFor(() => gemini.sent.some((msg) => msg.toolResponse), "working result");
  const working = gemini.sent.find((msg) => msg.toolResponse).toolResponse.functionResponses[0].response;
  assert.equal(working.status, "working");

  // The model fills the wait with a claim it cannot back.
  gemini.server({ serverContent: { modelTurn: { parts: [] }, outputTranscription: { text: "I've texted you the details already." } } });
  gemini.server({ serverContent: { generationComplete: true } });
  gemini.server({ serverContent: { turnComplete: true } });

  plan.lateAnswers.set("job-late", "Your dentist is at 3:15 PM tomorrow with Dr. Okafor.");
  await waitFor(
    () => gemini.sent.some((msg) => msg.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes("Dr. Okafor")),
    "late answer turn",
  );
  const late = gemini.sent.find((msg) => msg.clientContent?.turns?.[0]?.parts?.[0]?.text?.includes("Dr. Okafor"));
  const text = late.clientContent.turns[0].parts[0].text;
  assert.match(text, /answer to what the owner asked a moment ago is ready/);
  assert.match(text, /Correction: while this was running you told the owner it was already texted/);
  assert.ok(requests.some((r) => r.path.endsWith("/job-late/claim")));
  session.close();
});

test("hanging up with a late answer pending hands it to Joshu", async () => {
  const twilio = new FakeSocket();
  const session = new TwilioRealtimeSession(twilio);
  session.handleStart("CA-late-2", "MZ-2", { gate: { mode: "inbound", via: "trusted" } });
  const gemini = geminiSockets.at(-1);
  gemini.emit("open");
  gemini.server({ setupComplete: {} });
  gemini.server({ toolCall: { functionCalls: [{ id: "call-2", name: "think", args: { user_quote: "Find my flight" } }] } });
  await waitFor(() => gemini.sent.some((msg) => msg.toolResponse), "working result");
  session.close();
  await waitFor(() => requests.some((r) => r.path.endsWith("/job-late/detach")), "detach");
  assert.equal(requests.filter((r) => r.path.endsWith("/claim")).length, 0, "nothing spoken after hang-up");
});

test("late answers read as late, faithful relays", () => {
  const turn = injectHermesResultUserText("Dentist at 3:15 PM.", "voice_only", "late_answer");
  assert.match(turn, /you told them you were still working on it/);
  assert.match(turn, /never cutting the owner off/);
  assert.match(turn, /exactly as written/);
});
