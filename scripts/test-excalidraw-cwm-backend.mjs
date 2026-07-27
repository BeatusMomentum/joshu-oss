#!/usr/bin/env node
/**
 * Backend regression coverage for Curatorial Whiteboard persistence.
 * Usage: npm run build && npm run test:excalidraw-cwm-backend
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pathsModule = await import(
  pathToFileURL(path.join(rootDir, "dist/excalidraw/paths.js")).href
);
const storeModule = await import(
  pathToFileURL(path.join(rootDir, "dist/excalidraw/store.js")).href
);
const serviceModule = await import(
  pathToFileURL(path.join(rootDir, "dist/excalidraw/service.js")).href
);
const apiModule = await import(
  pathToFileURL(path.join(rootDir, "dist/excalidrawApi.js")).href
);

const { resolveCwmBoardPaths, resolveCwmHandoffPath } = pathsModule;
const { CwmBoardStore } = storeModule;
const { CwmBoardService } = serviceModule;
const { isLocalhostRequest, setCwmApiCors } = apiModule;

const scene = {
  type: "excalidraw",
  version: 2,
  source: "https://joshu.me",
  elements: [],
  appState: {},
  files: {},
};
const timestamp = "2026-07-27T02:00:00.000Z";

function semanticObject(id) {
  return {
    id,
    kind: "Claim",
    layer: "EVIDENCE",
    status: "CAPTURED",
    body: `Evidence ${id}`,
    createdBy: "AI",
    createdAt: timestamp,
    updatedAt: timestamp,
    provenance: [],
  };
}

function operationFor(id) {
  return { type: "UPSERT_OBJECT", object: semanticObject(id) };
}

let sequence = 0;
const dependencies = {
  now: () => timestamp,
  id: (prefix) => `${prefix}-${++sequence}`,
};

const tempRoot = await mkdtemp(path.join(tmpdir(), "joshu-cwm-backend-"));
const filesRoot = path.join(tempRoot, "files");
const boardRelativePath = "Planning/board.excalidraw";
const concurrentRelativePath = "Planning/concurrent.excalidraw";

try {
  await mkdir(path.join(filesRoot, "Planning"), { recursive: true });
  await writeFile(
    path.join(filesRoot, boardRelativePath),
    `${JSON.stringify(scene, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(filesRoot, concurrentRelativePath),
    `${JSON.stringify(scene, null, 2)}\n`,
    "utf8",
  );

  // Traversal and extension checks happen before any filesystem access.
  for (const invalidPath of [
    "../board.excalidraw",
    "Planning/../board.excalidraw",
    "Planning\\..\\board.excalidraw",
    "/Planning/board.excalidraw",
    "Planning/board.json",
    "Planning/board.EXCALIDRAW",
  ]) {
    assert.throws(() => resolveCwmBoardPaths(filesRoot, invalidPath), {
      name: "CwmInputError",
    });
  }
  assert.throws(() => resolveCwmHandoffPath(filesRoot, "../handoff.md"), {
    name: "CwmInputError",
  });

  assert.equal(
    isLocalhostRequest({ ip: "127.0.0.1", hostname: "127.0.0.1", socket: {} }),
    true,
  );
  assert.equal(
    isLocalhostRequest({
      ip: "203.0.113.10",
      hostname: "example.test",
      socket: { remoteAddress: "203.0.113.10" },
    }),
    false,
  );
  const corsHeaders = new Map();
  setCwmApiCors(
    { headers: { origin: "http://localhost:8787" } },
    { setHeader: (name, value) => corsHeaders.set(name, value) },
  );
  assert.equal(corsHeaders.get("Access-Control-Allow-Origin"), "http://localhost:8787");
  const remoteCorsHeaders = new Map();
  setCwmApiCors(
    { headers: { origin: "https://example.test" } },
    { setHeader: (name, value) => remoteCorsHeaders.set(name, value) },
  );
  assert.equal(remoteCorsHeaders.has("Access-Control-Allow-Origin"), false);

  const derived = resolveCwmBoardPaths(filesRoot, boardRelativePath);
  assert.equal(derived.workspacePath, `${derived.boardPath}.cwm.json`);
  assert.equal(derived.eventsPath, `${derived.boardPath}.cwm.events.jsonl`);

  const store = new CwmBoardStore(filesRoot);
  const service = new CwmBoardService(store, dependencies);

  // New boards are created exclusively with a blank scene and initialized sidecars.
  const createdRelativePath = "Planning/new-board.excalidraw";
  const created = await service.createBoard({ path: createdRelativePath });
  const createdPaths = resolveCwmBoardPaths(filesRoot, createdRelativePath);
  assert.equal(created.workspace.headSequence, 0);
  assert.deepEqual(
    JSON.parse(await readFile(createdPaths.boardPath, "utf8")).elements,
    [],
  );
  assert.equal(await readFile(createdPaths.eventsPath, "utf8"), "");
  assert.equal(
    JSON.parse(await readFile(createdPaths.workspacePath, "utf8")).id,
    created.workspace.id,
  );
  await assert.rejects(
    service.createBoard({ path: createdRelativePath }),
    (error) => error?.status === 409,
  );

  // Existing scenes bootstrap an empty, validated workspace and exact empty JSONL sibling.
  const bootstrapped = await service.getHead(boardRelativePath);
  assert.equal(bootstrapped.workspace.headSequence, 0);
  assert.deepEqual(bootstrapped.workspace.objects, {});
  assert.equal(await readFile(derived.eventsPath, "utf8"), "");
  assert.equal(
    JSON.parse(await readFile(derived.workspacePath, "utf8")).id,
    bootstrapped.workspace.id,
  );

  // Epistemic operations are staged by authority policy, then explicitly confirmed.
  const proposedA = await service.propose({
    path: boardRelativePath,
    headSequence: 0,
    operations: [operationFor("claim-a")],
    rationale: "Capture source-backed evidence",
  });
  assert.equal(proposedA.authority.disposition, "REQUIRE_CONFIRMATION");
  assert.equal(proposedA.proposal.status, "PENDING");
  assert.equal(proposedA.workspace.objects["claim-a"], undefined);
  assert.equal(proposedA.workspace.headSequence, 1);

  const confirmedA = await service.confirm({
    path: boardRelativePath,
    headSequence: 1,
    proposalId: proposedA.proposal.id,
  });
  assert.equal(confirmedA.workspace.objects["claim-a"].body, "Evidence claim-a");
  assert.equal(confirmedA.workspace.proposals[proposedA.proposal.id].status, "CONFIRMED");
  assert.equal(confirmedA.workspace.headSequence, 2);

  const proposedB = await service.propose({
    path: boardRelativePath,
    headSequence: 2,
    operations: [operationFor("claim-b")],
  });
  const rejectedB = await service.reject({
    path: boardRelativePath,
    headSequence: 3,
    proposalId: proposedB.proposal.id,
    reason: "Not enough support",
  });
  assert.equal(rejectedB.workspace.objects["claim-b"], undefined);
  assert.equal(rejectedB.workspace.proposals[proposedB.proposal.id].status, "REJECTED");
  assert.equal(rejectedB.workspace.headSequence, 4);

  await assert.rejects(
    service.propose({
      path: boardRelativePath,
      headSequence: 0,
      operations: [operationFor("stale")],
    }),
    (error) => error?.status === 409 && error?.details?.actualHeadSequence === 4,
  );

  // Compensation names the original materializing event and applies its stored inverse.
  const compensated = await service.compensate({
    path: boardRelativePath,
    headSequence: 4,
    eventId: confirmedA.event.id,
    reason: "Undo confirmed evidence",
  });
  assert.equal(compensated.event.compensatesEventId, confirmedA.event.id);
  assert.equal(compensated.workspace.objects["claim-a"], undefined);
  assert.equal(compensated.workspace.headSequence, 5);

  const checkpointScene = {
    ...scene,
    elements: [{ id: "shape-1", type: "rectangle", x: 10, y: 20 }],
    appState: { viewBackgroundColor: "#ffffff" },
  };
  const checkpointed = await service.checkpoint({
    path: boardRelativePath,
    headSequence: 5,
    scene: checkpointScene,
  });
  assert.equal(checkpointed.event.actionClass, "MECHANICAL");
  assert.match(checkpointed.event.reason, /^CHECKPOINT/);
  assert.deepEqual(JSON.parse(await readFile(derived.boardPath, "utf8")), checkpointScene);
  assert.equal(checkpointed.workspace.headSequence, 6);

  await assert.rejects(
    service.checkpoint({
      path: boardRelativePath,
      headSequence: 6,
      scene: { type: "excalidraw", version: 2, elements: [] },
    }),
    (error) => error?.status === 400,
  );

  const markdown = "# Curatorial handoff\n\n- Confirmed findings\n- Open questions\n";
  const consolidated = await service.consolidate({
    path: boardRelativePath,
    headSequence: 6,
    markdown,
    fileName: "session-handoff.md",
  });
  assert.equal(consolidated.handoffPath, "Planning/cwm-sessions/session-handoff.md");
  assert.equal(
    await readFile(path.join(filesRoot, consolidated.handoffPath), "utf8"),
    markdown,
  );
  assert.match(consolidated.event.reason, /^CONSOLIDATED Planning\/cwm-sessions\//);
  assert.equal(consolidated.workspace.headSequence, 7);

  const tail = await service.getEventTail(boardRelativePath, {
    afterSequence: 5,
    limit: 10,
  });
  assert.deepEqual(
    tail.events.map((event) => event.sequence),
    [6, 7],
  );

  // Simulate interruption after event append but before sidecar rename; read repairs by replay.
  await writeFile(
    derived.workspacePath,
    `${JSON.stringify(checkpointed.workspace, null, 2)}\n`,
    "utf8",
  );
  const recovered = await service.getHead(boardRelativePath);
  assert.equal(recovered.workspace.headSequence, 7);
  assert.equal(JSON.parse(await readFile(derived.workspacePath, "utf8")).headSequence, 7);

  // The per-board promise lock admits exactly one writer at a shared optimistic head.
  const concurrentResults = await Promise.allSettled([
    service.propose({
      path: concurrentRelativePath,
      headSequence: 0,
      operations: [operationFor("concurrent-a")],
    }),
    service.propose({
      path: concurrentRelativePath,
      headSequence: 0,
      operations: [operationFor("concurrent-b")],
    }),
  ]);
  assert.equal(
    concurrentResults.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = concurrentResults.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.status, 409);
  const concurrentHead = await service.getHead(concurrentRelativePath);
  assert.equal(concurrentHead.workspace.headSequence, 1);
  assert.equal(concurrentHead.events.length, 1);

  const lines = (await readFile(derived.eventsPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 7);
  console.log("OK: Curatorial Whiteboard backend persistence (11 coverage groups)");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
