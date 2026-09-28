/**
 * Scripted native-path smoke test against the real Gemini Live API (text turns, real
 * phone prompt + tools). Checks the three voice rules without placing a call:
 *
 *   1. general knowledge → answered directly, no tool
 *   2. owner info        → think; no owner facts spoken before the (canned) result
 *   3. long work         → start_task
 *
 *   node dist/geminiLiveNativeSmokeCli.js [model]
 *
 * Gated-call opener: N fresh sessions, each opened by
 * Joshu's one turn with an unheard result in context. Every run must give one
 * greeting, no tool call, no result read out — then a Spanish-sounding
 * follow-up must still get an English reply.
 *
 *   node dist/geminiLiveNativeSmokeCli.js --opener [runs] [model]
 *
 * Slow think (past the 10 s think budget): think returns "working", the answer
 * arrives later as a late-answer turn. The model must not guess meanwhile,
 * must not call it an error, and must relay the answer once.
 *
 *   node dist/geminiLiveNativeSmokeCli.js --late [runs] [model]
 *
 * Tool results are canned — Hermes and the broker are not called.
 */
import "./loadEnv.js";

import { GEMINI_LIVE_PHONE_THINKING_LEVEL, GEMINI_LIVE_MODEL, PHONE_SYSTEM_PROMPT } from "./config.js";
import { buildVoiceSystemPrompt, resolveJoshuIdentity } from "./joshuIdentity.js";
import { GeminiLiveClient } from "./geminiLiveClient.js";
import { PHONE_TOOL_NAMES } from "./realtimeTools.js";
import { detectLanguageMismatch, languageCorrection } from "./languageGuard.js";
import { buildInboundOpenerTurn, buildOpenerContext, type OpenerItem } from "./opener.js";

const SCENARIO_TIMEOUT_MS = 30_000;
/** How long the canned tool "runs" — long enough to hear what the model says meanwhile. */
const TOOL_DELAY_MS = 2_500;

type Scenario = {
  name: string;
  say: string;
  /** Tool the model should call (undefined = none). */
  expectTool?: "think" | "start_task";
  /** Canned tool result, and a fact from it that must not be spoken before it arrives. */
  result?: Record<string, unknown>;
  secretFact?: RegExp;
};

const SCENARIOS: Scenario[] = [
  { name: "general knowledge", say: "What's the capital of Australia?" },
  {
    name: "owner info",
    say: "What's on my calendar tomorrow?",
    expectTool: "think",
    result: {
      status: "done",
      source: "hermes",
      answer: "Tomorrow: dentist with Dr. Okafor at 3:15 PM, then dinner with Maya at 7.",
      instruction: "Relay this answer to the caller in plain, natural speech. Keep every time and name exactly as given.",
    },
    secretFact: /okafor|3:15|maya/i,
  },
  {
    name: "long work",
    say: "Find me nonstop flights from SFO to Austin next Tuesday under 400 dollars and compare the options.",
    expectTool: "start_task",
    result: {
      status: "queued",
      goal_id: "smoke",
      message: "That'll take a few minutes, so I'm working on it in the background. I'll call you back when it's done.",
      instruction: "Confirm to the owner in one or two natural sentences that this is queued, then carry on.",
    },
  },
];

type ScenarioReport = {
  name: string;
  tools: string[];
  beforeResult: string;
  afterResult: string;
  pass: boolean;
  notes: string[];
};

function runScenario(model: string, systemPrompt: string, scenario: Scenario): Promise<ScenarioReport> {
  return new Promise((resolve) => {
    const tools: string[] = [];
    let beforeResult = "";
    let afterResult = "";
    let resultSent = false;
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      client.close();
      const notes: string[] = [];
      const calledExpected = scenario.expectTool ? tools.includes(scenario.expectTool) : tools.length === 0;
      if (!calledExpected) {
        notes.push(scenario.expectTool ? `expected ${scenario.expectTool}` : "expected no tool call");
      }
      const leaked = scenario.secretFact?.test(beforeResult) ?? false;
      if (leaked) notes.push("owner fact spoken before the result (hallucination)");
      const relayed = !scenario.secretFact || scenario.secretFact.test(afterResult);
      if (!relayed) notes.push("result not relayed");
      resolve({
        name: scenario.name,
        tools,
        beforeResult: beforeResult.trim(),
        afterResult: afterResult.trim(),
        pass: calledExpected && !leaked && relayed,
        notes,
      });
    };

    const client = new GeminiLiveClient(
      {
        audioFormat: "pcmu",
        model,
        systemPrompt,
        toolNames: PHONE_TOOL_NAMES,
        thinkingLevel: GEMINI_LIVE_PHONE_THINKING_LEVEL,
      },
      {
        sessionId: `smoke:${scenario.name}`,
        onReady: () => client.sendUserText(scenario.say),
        onAssistantTranscript: (delta) => {
          if (resultSent) afterResult += delta;
          else beforeResult += delta;
        },
        onFunctionCall: ({ name, callId }) => {
          tools.push(name);
          const result = scenario.result ?? { status: "done", answer: "OK." };
          setTimeout(() => {
            resultSent = true;
            client.sendFunctionResult(callId, result);
          }, TOOL_DELAY_MS);
        },
        onResponseDone: () => {
          // No tool expected and none called: the direct answer is complete.
          if (!scenario.expectTool && tools.length === 0 && beforeResult.trim()) finish();
          // Result spoken.
          if (resultSent && afterResult.trim()) setTimeout(finish, 500);
        },
        onInteractionIdle: () => {
          if (resultSent || (!scenario.expectTool && beforeResult.trim())) finish();
        },
        onError: (message) => {
          console.error(`[gemini-smoke] ${scenario.name}: ${message}`);
          finish();
        },
      },
    );
    setTimeout(finish, SCENARIO_TIMEOUT_MS).unref();
    client.connect();
  });
}

const OPENER_ITEM: OpenerItem = {
  id: "smoke",
  kind: "completed",
  title: "Cancun flights",
  text: "Cheapest nonstop LAX to Cancun, Dec 20 to 27: Delta, $838 round trip, departing 7:40 AM.",
};

type OpenerReport = {
  greeting: string;
  responses: number;
  tools: string[];
  followUp: string;
  /** The guard corrected a wrong-language reply and the next one was English. */
  recovered: boolean;
  pass: boolean;
  notes: string[];
};

function runOpener(model: string): Promise<OpenerReport> {
  const ownerName = resolveJoshuIdentity().owner.displayName;
  return new Promise((resolve) => {
    let greeting = "";
    let followUp = "";
    let responses = 0;
    let phase: "opener" | "follow_up" | "recovery" = "opener";
    let recovery = "";
    let recovered = false;
    const tools: string[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      client.close();
      const notes: string[] = [];
      if (responses !== 1) notes.push(`expected one opening response, got ${responses}`);
      if (tools.length) notes.push(`tool call during opener: ${tools.join(",")}`);
      if (!greeting.trim()) notes.push("silent opener");
      if (/\$?838|7:40/.test(greeting)) notes.push("read the result before the owner asked");
      if (!followUp.trim()) notes.push("no reply to the follow-up");
      if (detectLanguageMismatch(followUp, "English").mismatch && !recovered) {
        notes.push("follow-up reply not in English, and the correction did not bring it back");
      }
      resolve({
        greeting: greeting.trim(),
        responses,
        tools,
        followUp: followUp.trim(),
        recovered,
        pass: notes.length === 0,
        notes,
      });
    };
    const client = new GeminiLiveClient(
      {
        audioFormat: "pcmu",
        model,
        systemPrompt: buildVoiceSystemPrompt(resolveJoshuIdentity(), "phone", { nativeAsyncTools: true }),
        systemPromptExtra: Promise.resolve(buildOpenerContext("inbound", { items: [OPENER_ITEM] })),
        toolNames: PHONE_TOOL_NAMES,
        thinkingLevel: GEMINI_LIVE_PHONE_THINKING_LEVEL,
      },
      {
        sessionId: "smoke:opener",
        onReady: () => client.injectAssistantMessage(buildInboundOpenerTurn(ownerName, [OPENER_ITEM]), "control_turn"),
        onAssistantTranscript: (delta) => {
          if (phase === "opener") greeting += delta;
          else if (phase === "follow_up") followUp += delta;
          else recovery += delta;
        },
        onFunctionCall: ({ name, callId }) => {
          tools.push(name);
          client.sendFunctionResult(callId, { status: "done", answer: "OK." });
        },
        onResponseDone: ({ status }) => {
          if (status === "cancelled") return;
          if (phase === "opener") {
            responses += 1;
            // Anything else the model says unprompted within 3 s counts as a second greeting.
            setTimeout(() => {
              if (done || phase !== "opener") return;
              phase = "follow_up";
              client.sendUserText("Hola, sí, ¿cuánto cuesta el vuelo más barato?");
            }, 3_000);
          } else if (phase === "follow_up" && followUp.trim()) {
            if (!detectLanguageMismatch(followUp, "English").mismatch) {
              setTimeout(finish, 500);
              return;
            }
            // What the session does on a live call: one correction, then carry on.
            phase = "recovery";
            client.appendContext(languageCorrection("English", detectLanguageMismatch(followUp, "English").detected));
            client.sendUserText("¿Y a qué hora sale?");
          } else if (phase === "recovery" && recovery.trim()) {
            recovered = !detectLanguageMismatch(recovery, "English").mismatch;
            setTimeout(finish, 500);
          }
        },
        onError: (message) => {
          console.error(`[gemini-smoke] opener: ${message}`);
          finish();
        },
      },
    );
    setTimeout(finish, SCENARIO_TIMEOUT_MS).unref();
    client.connect();
  });
}

async function runOpeners(model: string, runs: number): Promise<number> {
  let failures = 0;
  for (let run = 1; run <= runs; run += 1) {
    const report = await runOpener(model);
    if (!report.pass) failures += 1;
    console.info(
      `[gemini-smoke] ${report.pass ? "PASS" : "FAIL"} opener ${run}/${runs}`,
      JSON.stringify({
        greeting: report.greeting.slice(0, 200),
        followUp: report.followUp.slice(0, 200),
        ...(report.recovered ? { recoveredAfterCorrection: true } : {}),
        notes: report.notes,
      }),
    );
  }
  console.info(`[gemini-smoke] opener: ${runs - failures}/${runs} clean`);
  return failures;
}

type LateReport = { meanwhile: string; late: string; tools: string[]; pass: boolean; notes: string[] };

const LATE_ANSWER = "Tomorrow: dentist with Dr. Okafor at 3:15 PM, then dinner with Maya at 7.";

function runLate(model: string): Promise<LateReport> {
  return new Promise((resolve) => {
    let meanwhile = "";
    let late = "";
    let lateSent = false;
    const tools: string[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      client.close();
      const notes: string[] = [];
      if (!tools.includes("think")) notes.push("expected think");
      if (/okafor|3:15|maya/i.test(meanwhile)) notes.push("owner facts before the answer (guess)");
      if (/error|problem|trouble|went wrong/i.test(meanwhile)) notes.push("'working' read as an error");
      if (!/okafor/i.test(late)) notes.push("late answer not relayed");
      if ((late.match(/okafor/gi) ?? []).length > 1) notes.push("late answer relayed twice");
      resolve({ meanwhile: meanwhile.trim(), late: late.trim(), tools, pass: notes.length === 0, notes });
    };
    const client = new GeminiLiveClient(
      {
        audioFormat: "pcmu",
        model,
        systemPrompt: buildVoiceSystemPrompt(resolveJoshuIdentity(), "phone", { nativeAsyncTools: true }),
        toolNames: PHONE_TOOL_NAMES,
        thinkingLevel: GEMINI_LIVE_PHONE_THINKING_LEVEL,
      },
      {
        sessionId: "smoke:late",
        onReady: () => client.sendUserText("What's on my calendar tomorrow?"),
        onAssistantTranscript: (delta) => {
          if (lateSent) late += delta;
          else meanwhile += delta;
        },
        onFunctionCall: ({ name, callId }) => {
          tools.push(name);
          if (name !== "think") {
            client.sendFunctionResult(callId, { status: "done", answer: "OK." });
            return;
          }
          client.sendFunctionResult(callId, {
            status: "working",
            job_id: "smoke",
            instruction:
              "Tell the owner in one short sentence that you're still working on it and will tell them as soon as it's ready. Do not guess, and do not give a partial answer. Keep talking with them normally meanwhile.",
          });
          setTimeout(() => {
            lateSent = true;
            client.injectAssistantMessage(LATE_ANSWER, "late_answer");
          }, 6_000);
        },
        onResponseDone: ({ status }) => {
          if (status !== "cancelled" && lateSent && late.trim()) setTimeout(finish, 2_500);
        },
        onError: (message) => {
          console.error(`[gemini-smoke] late: ${message}`);
          finish();
        },
      },
    );
    setTimeout(finish, SCENARIO_TIMEOUT_MS).unref();
    client.connect();
  });
}

async function runLates(model: string, runs: number): Promise<number> {
  let failures = 0;
  for (let run = 1; run <= runs; run += 1) {
    const report = await runLate(model);
    if (!report.pass) failures += 1;
    console.info(
      `[gemini-smoke] ${report.pass ? "PASS" : "FAIL"} late ${run}/${runs}`,
      JSON.stringify({ meanwhile: report.meanwhile.slice(0, 200), late: report.late.slice(0, 200), tools: report.tools, notes: report.notes }),
    );
  }
  console.info(`[gemini-smoke] late: ${runs - failures}/${runs} clean`);
  return failures;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--late") {
    const runs = Number.parseInt(args[1] ?? "", 10);
    const model = args.slice(1).find((arg) => !/^\d+$/.test(arg)) ?? GEMINI_LIVE_MODEL;
    process.exit((await runLates(model, Number.isFinite(runs) && runs > 0 ? runs : 10)) ? 1 : 0);
  }
  if (args[0] === "--opener") {
    const runs = Number.parseInt(args[1] ?? "", 10);
    const model = args.slice(1).find((arg) => !/^\d+$/.test(arg)) ?? GEMINI_LIVE_MODEL;
    process.exit((await runOpeners(model, Number.isFinite(runs) && runs > 0 ? runs : 20)) ? 1 : 0);
  }
  const model = args.find((arg) => !arg.startsWith("--")) ?? GEMINI_LIVE_MODEL;
  const probe = new GeminiLiveClient({ model }, {});
  // Env prompt tracks GEMINI_LIVE_MODEL; build the native prompt for the model under test.
  const systemPrompt = probe.nativeAsyncTools
    ? buildVoiceSystemPrompt(resolveJoshuIdentity(), "phone", { nativeAsyncTools: true })
    : PHONE_SYSTEM_PROMPT;
  console.info(`[gemini-smoke] model=${model} nativeAsyncTools=${probe.nativeAsyncTools}`);

  let failures = 0;
  for (const scenario of SCENARIOS) {
    const report = await runScenario(model, systemPrompt, scenario);
    if (!report.pass) failures += 1;
    console.info(
      `[gemini-smoke] ${report.pass ? "PASS" : "FAIL"} ${report.name}`,
      JSON.stringify(
        {
          tools: report.tools,
          said: report.beforeResult.slice(0, 240),
          afterResult: report.afterResult.slice(0, 240),
          notes: report.notes,
        },
        null,
        2,
      ),
    );
  }
  process.exit(failures ? 1 : 0);
}

void main();
