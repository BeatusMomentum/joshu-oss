import assert from "node:assert/strict";
import test from "node:test";

import { createProgrammaticPromptRequestGate } from "../dist/programmaticPromptRequest.js";

test("programmatic prompt requests are idempotent within a thread", () => {
  const gate = createProgrammaticPromptRequestGate();
  const request = { id: "start-1", text: "  Start the session.  " };

  assert.deepEqual(gate.claim("thread-a", request), {
    id: "start-1",
    text: "Start the session.",
  });
  assert.equal(gate.claim("thread-a", request), null);
  assert.deepEqual(gate.claim("thread-b", request), {
    id: "start-1",
    text: "Start the session.",
  });
});

test("invalid and recently evicted requests are handled safely", () => {
  const gate = createProgrammaticPromptRequestGate(1);

  assert.equal(gate.claim("thread", { id: "", text: "prompt" }), null);
  assert.equal(gate.claim("thread", { id: "one", text: " " }), null);
  assert.ok(gate.claim("thread", { id: "one", text: "First" }));
  assert.ok(gate.claim("thread", { id: "two", text: "Second" }));
  assert.ok(gate.claim("thread", { id: "one", text: "First after eviction" }));
});
