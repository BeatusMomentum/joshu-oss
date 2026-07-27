import {
  assertValidCwmEvent,
  assertValidCwmWorkspace,
  createEmptyWorkspace,
  reduceCwmWorkspace,
  type CwmEvent,
  type CwmWorkspace,
} from "@joshu/whiteboard-cwm";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  CwmBoardNotFoundError,
  CwmConflictError,
  CwmInputError,
  CwmStoreCorruptError,
} from "./errors.js";
import { resolveCwmBoardPaths, type CwmBoardPaths } from "./paths.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function cwmWorkspaceId(relativePath: string): string {
  return `cwm-${createHash("sha256").update(relativePath).digest("hex")}`;
}

export interface StagedAtomicText {
  readonly targetPath: string;
  readonly tempPath: string;
  commit(): Promise<void>;
  cleanup(): Promise<void>;
}

/** Stage a same-directory write so commit is one atomic rename. */
export async function stageAtomicText(targetPath: string, content: string): Promise<StagedAtomicText> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  let staged = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    staged = true;
  } finally {
    await handle.close();
    if (!staged) await rm(tempPath, { force: true });
  }

  let committed = false;
  return {
    targetPath,
    tempPath,
    async commit(): Promise<void> {
      await rename(tempPath, targetPath);
      committed = true;
    },
    async cleanup(): Promise<void> {
      if (!committed) await rm(tempPath, { force: true });
    },
  };
}

export async function atomicWriteText(targetPath: string, content: string): Promise<void> {
  const staged = await stageAtomicText(targetPath, content);
  try {
    await staged.commit();
  } finally {
    await staged.cleanup();
  }
}

export async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await atomicWriteText(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function rejectSymlinkIfPresent(filePath: string, label: string): Promise<void> {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new CwmInputError(`${label} must not be a symbolic link`);
    }
    if (!stat.isFile()) {
      throw new CwmStoreCorruptError(`${label} is not a regular file`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Create each missing parent one segment at a time and verify that existing
 * symlinks never redirect board creation outside the resolved files root.
 */
async function ensureSafeBoardParent(paths: CwmBoardPaths): Promise<void> {
  const realRoot = await realpath(paths.filesRoot);
  const relativeParent = path.relative(paths.filesRoot, path.dirname(paths.boardPath));
  let current = paths.filesRoot;

  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current, { mode: 0o700 });
      stat = await lstat(current);
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new CwmInputError("board parent must be a directory");
    }
    const resolved = await realpath(current);
    if (!isPathWithin(realRoot, resolved)) {
      throw new CwmInputError("board parent resolves outside joshu's files");
    }
  }
}

async function appendEventLine(eventsPath: string, event: CwmEvent): Promise<void> {
  await rejectSymlinkIfPresent(eventsPath, "CWM event log");
  await mkdir(path.dirname(eventsPath), { recursive: true });
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(
    eventsPath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readCwmEventsFile(eventsPath: string): Promise<readonly CwmEvent[]> {
  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const events: CwmEvent[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const event = assertValidCwmEvent(JSON.parse(line));
      events.push(event);
    } catch (error) {
      throw new CwmStoreCorruptError(
        `Invalid CWM event log line ${index + 1}: ${errorMessage(error)}`,
      );
    }
  }
  return events;
}

/** FIFO promise chain keyed by absolute board path; failures never poison later callers. */
export class CwmBoardPromiseLock {
  private readonly chains = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.chains.set(key, queued);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.chains.get(key) === queued) this.chains.delete(key);
    }
  }
}

export interface CwmLoadedBoard {
  readonly paths: CwmBoardPaths;
  readonly workspace: CwmWorkspace;
  readonly events: readonly CwmEvent[];
}

export interface CwmArtifactWrite {
  readonly targetPath: string;
  readonly content: string;
}

export interface CwmPreparedMutation {
  readonly event: CwmEvent;
  readonly artifact?: CwmArtifactWrite;
}

export interface CwmCommittedMutation extends CwmLoadedBoard {
  readonly event: CwmEvent;
}

export interface CwmEventTail {
  readonly paths: CwmBoardPaths;
  readonly headSequence: number;
  readonly events: readonly CwmEvent[];
}

export class CwmBoardStore {
  readonly filesRoot: string;
  readonly lock: CwmBoardPromiseLock;

  constructor(filesRoot: string, lock = new CwmBoardPromiseLock()) {
    this.filesRoot = path.resolve(filesRoot);
    this.lock = lock;
  }

  private async assertExistingBoard(paths: CwmBoardPaths): Promise<void> {
    let stat;
    try {
      stat = await lstat(paths.boardPath);
    } catch (error) {
      if (isMissing(error)) throw new CwmBoardNotFoundError(paths.relativePath);
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new CwmBoardNotFoundError(paths.relativePath);
    }

    // Parent-directory symlinks are acceptable only when their resolved target remains under
    // the resolved files root. The board itself stays a regular file so checkpoint rename is sane.
    const [realRoot, realBoard] = await Promise.all([
      realpath(paths.filesRoot),
      realpath(paths.boardPath),
    ]);
    if (!isPathWithin(realRoot, realBoard)) {
      throw new CwmInputError("board resolves outside joshu's files");
    }
  }

  private async loadUnlocked(paths: CwmBoardPaths): Promise<CwmLoadedBoard> {
    await this.assertExistingBoard(paths);
    await rejectSymlinkIfPresent(paths.workspacePath, "CWM workspace sidecar");
    await rejectSymlinkIfPresent(paths.eventsPath, "CWM event log");

    const expectedWorkspaceId = cwmWorkspaceId(paths.relativePath);
    let workspace: CwmWorkspace;
    try {
      const raw = await readFile(paths.workspacePath, "utf8");
      workspace = assertValidCwmWorkspace(JSON.parse(raw));
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof CwmStoreCorruptError) throw error;
        throw new CwmStoreCorruptError(`Invalid CWM workspace sidecar: ${errorMessage(error)}`);
      }
      workspace = createEmptyWorkspace({ id: expectedWorkspaceId });
      await atomicWriteJson(paths.workspacePath, workspace);
    }

    if (workspace.id !== expectedWorkspaceId) {
      throw new CwmStoreCorruptError(
        `Workspace ID does not match board path: expected ${expectedWorkspaceId}`,
      );
    }

    // Opening with append creates the exact empty JSONL sidecar during first-board bootstrap.
    const eventHandle = await open(
      paths.eventsPath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await eventHandle.close();
    const events = await readCwmEventsFile(paths.eventsPath);

    for (const [index, event] of events.entries()) {
      const expectedSequence = index + 1;
      if (event.sequence !== expectedSequence || event.workspaceId !== expectedWorkspaceId) {
        throw new CwmStoreCorruptError(
          `CWM event ${event.id} has invalid sequence or workspace identity`,
        );
      }
    }
    if (workspace.headSequence > events.length) {
      throw new CwmStoreCorruptError(
        `Workspace head ${workspace.headSequence} is ahead of event log ${events.length}`,
      );
    }

    // Event append intentionally precedes sidecar rename. If a process stopped between those
    // writes, replay the durable tail and repair the materialized sidecar here.
    if (workspace.headSequence < events.length) {
      try {
        for (const event of events.slice(workspace.headSequence)) {
          workspace = reduceCwmWorkspace(workspace, event);
        }
        workspace = assertValidCwmWorkspace(workspace);
      } catch (error) {
        throw new CwmStoreCorruptError(`Could not replay CWM event tail: ${errorMessage(error)}`);
      }
      await atomicWriteJson(paths.workspacePath, workspace);
    }

    return { paths, workspace, events };
  }

  async getHead(relativePath: string): Promise<CwmLoadedBoard> {
    const paths = resolveCwmBoardPaths(this.filesRoot, relativePath);
    return this.lock.run(paths.boardPath, () => this.loadUnlocked(paths));
  }

  /** Exclusively create a new board, then initialize its exact CWM sidecars. */
  async createBoard(relativePath: string, content: string): Promise<CwmLoadedBoard> {
    const paths = resolveCwmBoardPaths(this.filesRoot, relativePath);
    return this.lock.run(paths.boardPath, async () => {
      await ensureSafeBoardParent(paths);
      if (
        (await pathExists(paths.boardPath)) ||
        (await pathExists(paths.workspacePath)) ||
        (await pathExists(paths.eventsPath))
      ) {
        throw new CwmConflictError(`Board "${paths.relativePath}" already exists`);
      }

      const workspace = assertValidCwmWorkspace(
        createEmptyWorkspace({ id: cwmWorkspaceId(paths.relativePath) }),
      );
      const files = [
        [paths.boardPath, content],
        [paths.workspacePath, `${JSON.stringify(workspace, null, 2)}\n`],
        [paths.eventsPath, ""],
      ] as const;
      const createdPaths: string[] = [];

      try {
        for (const [filePath, fileContent] of files) {
          const handle = await open(
            filePath,
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_WRONLY |
              (constants.O_NOFOLLOW ?? 0),
            0o600,
          );
          createdPaths.push(filePath);
          try {
            await handle.writeFile(fileContent, "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
      } catch (error) {
        // Remove only paths that this exclusive-create attempt opened.
        await Promise.all(createdPaths.map((filePath) => rm(filePath, { force: true })));
        if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
          throw new CwmConflictError(`Board "${paths.relativePath}" already exists`);
        }
        throw error;
      }

      return { paths, workspace, events: [] };
    });
  }

  async getEventTail(
    relativePath: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<CwmEventTail> {
    const loaded = await this.getHead(relativePath);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new CwmInputError("limit must be an integer from 1 through 500");
    }
    if (
      options.afterSequence !== undefined &&
      (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0)
    ) {
      throw new CwmInputError("afterSequence must be a non-negative safe integer");
    }
    const events =
      options.afterSequence === undefined
        ? loaded.events.slice(-limit)
        : loaded.events.filter((event) => event.sequence > options.afterSequence!).slice(0, limit);
    return {
      paths: loaded.paths,
      headSequence: loaded.workspace.headSequence,
      events,
    };
  }

  async mutate(
    relativePath: string,
    expectedHeadSequence: number,
    prepare: (loaded: CwmLoadedBoard) => CwmPreparedMutation | Promise<CwmPreparedMutation>,
  ): Promise<CwmCommittedMutation> {
    if (!Number.isSafeInteger(expectedHeadSequence) || expectedHeadSequence < 0) {
      throw new CwmInputError("headSequence must be a non-negative safe integer");
    }
    const paths = resolveCwmBoardPaths(this.filesRoot, relativePath);
    return this.lock.run(paths.boardPath, async () => {
      const loaded = await this.loadUnlocked(paths);
      if (loaded.workspace.headSequence !== expectedHeadSequence) {
        throw new CwmConflictError("CWM board head has changed", {
          expectedHeadSequence,
          actualHeadSequence: loaded.workspace.headSequence,
          workspace: loaded.workspace,
        });
      }

      const prepared = await prepare(loaded);
      const event = assertValidCwmEvent(prepared.event);
      const nextWorkspace = assertValidCwmWorkspace(
        reduceCwmWorkspace(loaded.workspace, event),
      );

      let stagedArtifact: StagedAtomicText | undefined;
      if (prepared.artifact) {
        if (!isPathWithin(paths.filesRoot, prepared.artifact.targetPath)) {
          throw new CwmInputError("artifact path must stay within joshu's files");
        }
        if (
          prepared.artifact.targetPath === paths.workspacePath ||
          prepared.artifact.targetPath === paths.eventsPath
        ) {
          throw new CwmInputError("artifact cannot overwrite CWM sidecars");
        }
        stagedArtifact = await stageAtomicText(
          prepared.artifact.targetPath,
          prepared.artifact.content,
        );
      }

      try {
        // Durable audit order is deliberate: event first, optional artifact rename second,
        // materialized sidecar rename last. loadUnlocked repairs a missing final sidecar rename.
        await appendEventLine(paths.eventsPath, prepared.event);
        await stagedArtifact?.commit();
        await atomicWriteJson(paths.workspacePath, nextWorkspace);
      } finally {
        await stagedArtifact?.cleanup();
      }

      return {
        paths,
        workspace: nextWorkspace,
        events: [...loaded.events, prepared.event],
        event: prepared.event,
      };
    });
  }
}
