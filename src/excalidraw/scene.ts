import { CwmInputError } from "./errors.js";

export interface ExcalidrawSceneEnvelope {
  readonly type: "excalidraw";
  readonly version: number;
  readonly source?: string;
  readonly elements: readonly unknown[];
  readonly appState: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonValue(value: unknown, path: string, depth = 0): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (depth >= 50) throw new CwmInputError(`${path} is nested too deeply`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new CwmInputError(`${path} must contain JSON values only`);
}

/** Validate the stable envelope emitted by Excalidraw's serializeAsJSON utility. */
export function parseExcalidrawSceneEnvelope(value: unknown): ExcalidrawSceneEnvelope {
  if (!isRecord(value)) throw new CwmInputError("scene must be an object");
  if (value.type !== "excalidraw") {
    throw new CwmInputError('scene.type must equal "excalidraw"');
  }
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    throw new CwmInputError("scene.version must be a positive safe integer");
  }
  if (value.source !== undefined && typeof value.source !== "string") {
    throw new CwmInputError("scene.source must be a string when present");
  }
  if (!Array.isArray(value.elements)) {
    throw new CwmInputError("scene.elements must be an array");
  }
  if (!isRecord(value.appState)) {
    throw new CwmInputError("scene.appState must be an object");
  }
  if (!isRecord(value.files)) {
    throw new CwmInputError("scene.files must be an object");
  }
  assertJsonValue(value, "scene");
  return value as ExcalidrawSceneEnvelope;
}
