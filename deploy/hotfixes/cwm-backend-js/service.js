import { CWM_ACTORS, MAX_CWM_HANDOFF_MARKDOWN_LENGTH, assertValidCwmOperation, classifyCwmOperations, createCompensatingEvent, createEmptyWorkspace, deriveInverseOperations, getAuthorityPolicy, replayCwmEvents, } from "@joshu/whiteboard-cwm";
import { randomUUID } from "node:crypto";
import { CwmConflictError, CwmInputError } from "./errors.js";
import { defaultCwmHandoffFileName, resolveCwmHandoffPath, } from "./paths.js";
import { parseExcalidrawSceneEnvelope } from "./scene.js";
function requireActor(value, fallback) {
    const actor = value ?? fallback;
    if (!CWM_ACTORS.includes(actor))
        throw new CwmInputError("actor is invalid");
    return actor;
}
function requireId(value, label) {
    if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
        throw new CwmInputError(`${label} is required`);
    }
    return value;
}
function reasonField(reason) {
    if (reason === undefined)
        return {};
    if (typeof reason !== "string" || reason.length > 20_000) {
        throw new CwmInputError("reason must be a string of at most 20000 characters");
    }
    return { reason };
}
function resultFromCommit(committed, extras = {}) {
    return {
        workspace: committed.workspace,
        event: committed.event,
        ...extras,
    };
}
export class CwmBoardService {
    store;
    now;
    id;
    constructor(store, dependencies = {}) {
        this.store = store;
        this.now = dependencies.now ?? (() => new Date().toISOString());
        this.id = dependencies.id ?? ((prefix) => `${prefix}-${randomUUID()}`);
    }
    getHead(path) {
        return this.store.getHead(path);
    }
    createBoard(input) {
        const scene = parseExcalidrawSceneEnvelope({
            type: "excalidraw",
            version: 2,
            source: "https://joshu.me",
            elements: [],
            appState: { viewBackgroundColor: "#ffffff" },
            files: {},
        });
        return this.store.createBoard(input.path, `${JSON.stringify(scene, null, 2)}\n`);
    }
    getEventTail(path, options) {
        return this.store.getEventTail(path, options);
    }
    async propose(input) {
        const actor = requireActor(input.actor, "AI");
        if (!Array.isArray(input.operations) || input.operations.length === 0) {
            throw new CwmInputError("operations must contain at least one semantic operation");
        }
        const operations = input.operations.map((operation) => assertValidCwmOperation(operation));
        let authority;
        let proposal;
        const committed = await this.store.mutate(input.path, input.headSequence, (loaded) => {
            const actionClass = classifyCwmOperations(operations, loaded.workspace);
            authority = getAuthorityPolicy(actionClass);
            const occurredAt = this.now();
            const sequence = loaded.workspace.headSequence + 1;
            if (authority.appliesImmediately) {
                const inverseOperations = authority.reversible
                    ? deriveInverseOperations(loaded.workspace, operations)
                    : undefined;
                const event = {
                    id: this.id("event"),
                    workspaceId: loaded.workspace.id,
                    sequence,
                    kind: "OPERATIONS_APPLIED",
                    actor,
                    actionClass,
                    occurredAt,
                    operations,
                    ...(inverseOperations === undefined ? {} : { inverseOperations }),
                    ...reasonField(input.rationale),
                };
                return { event };
            }
            proposal = {
                id: this.id("proposal"),
                workspaceId: loaded.workspace.id,
                proposedBy: actor,
                actionClass,
                operations,
                ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
                status: "PENDING",
                createdAt: occurredAt,
            };
            const event = {
                id: this.id("event"),
                workspaceId: loaded.workspace.id,
                sequence,
                kind: "PROPOSAL_CREATED",
                actor,
                actionClass,
                occurredAt,
                operations: [],
                proposal,
                ...reasonField(input.rationale),
            };
            return { event };
        });
        return resultFromCommit(committed, { authority, ...(proposal ? { proposal } : {}) });
    }
    async confirm(input) {
        const actor = requireActor(input.actor, "HUMAN");
        const proposalId = requireId(input.proposalId, "proposalId");
        const committed = await this.store.mutate(input.path, input.headSequence, (loaded) => {
            const proposal = loaded.workspace.proposals[proposalId];
            if (!proposal)
                throw new CwmConflictError(`Proposal "${proposalId}" does not exist`);
            if (proposal.status !== "PENDING") {
                throw new CwmConflictError(`Proposal "${proposalId}" is already ${proposal.status}`);
            }
            const operations = proposal.operations;
            const event = {
                id: this.id("event"),
                workspaceId: loaded.workspace.id,
                sequence: loaded.workspace.headSequence + 1,
                kind: "PROPOSAL_CONFIRMED",
                actor,
                actionClass: proposal.actionClass,
                occurredAt: this.now(),
                operations,
                inverseOperations: deriveInverseOperations(loaded.workspace, operations),
                proposalId,
                ...reasonField(input.reason),
            };
            return { event };
        });
        return resultFromCommit(committed);
    }
    async reject(input) {
        const actor = requireActor(input.actor, "HUMAN");
        const proposalId = requireId(input.proposalId, "proposalId");
        const committed = await this.store.mutate(input.path, input.headSequence, (loaded) => {
            const proposal = loaded.workspace.proposals[proposalId];
            if (!proposal)
                throw new CwmConflictError(`Proposal "${proposalId}" does not exist`);
            if (proposal.status !== "PENDING") {
                throw new CwmConflictError(`Proposal "${proposalId}" is already ${proposal.status}`);
            }
            const event = {
                id: this.id("event"),
                workspaceId: loaded.workspace.id,
                sequence: loaded.workspace.headSequence + 1,
                kind: "PROPOSAL_REJECTED",
                actor,
                actionClass: proposal.actionClass,
                occurredAt: this.now(),
                operations: [],
                proposalId,
                ...reasonField(input.reason),
            };
            return { event };
        });
        return resultFromCommit(committed);
    }
    async compensate(input) {
        const actor = requireActor(input.actor, "HUMAN");
        const eventId = requireId(input.eventId, "eventId");
        const committed = await this.store.mutate(input.path, input.headSequence, (loaded) => {
            const originalIndex = loaded.events.findIndex((event) => event.id === eventId);
            if (originalIndex < 0)
                throw new CwmConflictError(`Event "${eventId}" does not exist`);
            if (loaded.events.some((event) => event.compensatesEventId === eventId)) {
                throw new CwmConflictError(`Event "${eventId}" has already been compensated`);
            }
            const original = loaded.events[originalIndex];
            const beforeOriginal = replayCwmEvents(createEmptyWorkspace({ id: loaded.workspace.id }), loaded.events.slice(0, originalIndex));
            const event = createCompensatingEvent(original, beforeOriginal, {
                id: this.id("event"),
                sequence: loaded.workspace.headSequence + 1,
                actor,
                occurredAt: this.now(),
                ...reasonField(input.reason),
            });
            return { event };
        });
        return resultFromCommit(committed);
    }
    async checkpoint(input) {
        const actor = requireActor(input.actor, "HUMAN");
        const scene = parseExcalidrawSceneEnvelope(input.scene);
        const committed = await this.store.mutate(input.path, input.headSequence, (loaded) => {
            const marker = input.reason ? `CHECKPOINT: ${input.reason}` : "CHECKPOINT";
            const event = {
                id: this.id("event"),
                workspaceId: loaded.workspace.id,
                sequence: loaded.workspace.headSequence + 1,
                kind: "OPERATIONS_APPLIED",
                actor,
                actionClass: "MECHANICAL",
                occurredAt: this.now(),
                operations: [],
                inverseOperations: [],
                reason: marker,
            };
            return {
                event,
                artifact: {
                    targetPath: loaded.paths.boardPath,
                    content: `${JSON.stringify(scene, null, 2)}\n`,
                },
            };
        });
        return resultFromCommit(committed);
    }
    async consolidate(input) {
        const actor = requireActor(input.actor, "AI");
        if (typeof input.markdown !== "string" || !input.markdown.trim()) {
            throw new CwmInputError("markdown must be a non-empty string");
        }
        if (input.markdown.length > MAX_CWM_HANDOFF_MARKDOWN_LENGTH) {
            throw new CwmInputError(`markdown must be at most ${MAX_CWM_HANDOFF_MARKDOWN_LENGTH} characters`);
        }
        let handoff;
        const committed = await this.store.mutate(input.path, input.headSequence, (loaded) => {
            const occurredAt = this.now();
            const eventId = this.id("event");
            const fileName = input.fileName ?? defaultCwmHandoffFileName(occurredAt, eventId);
            handoff = resolveCwmHandoffPath(loaded.paths.filesRoot, fileName);
            const event = {
                id: eventId,
                workspaceId: loaded.workspace.id,
                sequence: loaded.workspace.headSequence + 1,
                kind: "OPERATIONS_APPLIED",
                actor,
                actionClass: "MECHANICAL",
                occurredAt,
                operations: [],
                inverseOperations: [],
                reason: `CONSOLIDATED ${handoff.relativePath}`,
            };
            return {
                event,
                artifact: {
                    targetPath: handoff.absolutePath,
                    content: input.markdown.endsWith("\n") ? input.markdown : `${input.markdown}\n`,
                },
            };
        });
        return resultFromCommit(committed, { handoffPath: handoff.relativePath });
    }
}
//# sourceMappingURL=service.js.map