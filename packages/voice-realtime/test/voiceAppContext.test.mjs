import assert from "node:assert/strict";
import test from "node:test";

import {
  SURFACE_APP_DESKTOP_MODULE,
  buildEmbeddedAppThinkMessages,
  surfaceTargetsCurrentApp,
} from "../dist/voiceAppContext.js";

test("maps Excalidraw surface to the jWhiteboard desktop module", () => {
  assert.equal(SURFACE_APP_DESKTOP_MODULE.excalidraw, "jWhiteboard");
  assert.equal(surfaceTargetsCurrentApp("excalidraw", "jWhiteboard"), true);
  assert.equal(surfaceTargetsCurrentApp("excalidraw", "jMail"), false);
});

test("whiteboard voice context enforces visible low-confidence grounding", () => {
  const messages = buildEmbeddedAppThinkMessages({
    appId: "excalidraw",
    threadId: "thread-one",
    mode: "embedded",
    guiActions: ["showFocus", "proposeTransaction"],
    guiSnapshot: {
      deicticContext: {
        confidence: 0.62,
        groundingRequired: true,
        cwmObjectIds: ["claim-one"],
      },
    },
  });
  const prompt = messages.map((message) => message.content).join("\n");

  assert.match(prompt, /call showFocus/i);
  assert.match(prompt, /ask one compact confirmation question/i);
  assert.match(prompt, /human-only visible review controls/i);
});
