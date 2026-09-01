import fs from "node:fs";
import {
  composioActionId,
  isActionGuardedExternalWrites,
  isComposioToolGuarded,
  isConnectorsToolGuarded,
} from "./classify.js";
import { actionGuardPolicyPath } from "./paths.js";
import { isOwnerChannelLinked } from "../ownerChannel/config.js";

export type ActionGuardGateMode = "allowlist" | "external_writes";

export type ActionGuardPolicy = {
  enabled: boolean;
  gateMode: ActionGuardGateMode;
  guardedActions: string[];
  approvalTimeoutMs: number;
  /** When true, sends where every recipient is primaryWorkEmail bypass the gate. */
  bypassSummaryEmailToOwner: boolean;
  /** Generalized owner-only recipient bypass for mail actions. */
  bypassOwnerOnlyRecipients: boolean;
  /** Soft LLM classifier for ambiguous actions. */
  llmClassifier: boolean;
  llmClassifierThreshold: number;
  /** Gate browser click/type/press/evaluate via Hermes patch. */
  browserGateWrites: boolean;
};

const DEFAULT_GUARDED_ACTIONS = [
  "nylas_send_message",
  "composio:GMAIL_SEND_EMAIL",
  "composio:GMAIL_REPLY_TO_THREAD",
];

const DEFAULT_POLICY: ActionGuardPolicy = {
  enabled: false,
  gateMode: "external_writes",
  guardedActions: DEFAULT_GUARDED_ACTIONS,
  approvalTimeoutMs: 30 * 60 * 1000,
  bypassSummaryEmailToOwner: true,
  bypassOwnerOnlyRecipients: true,
  llmClassifier: false,
  llmClassifierThreshold: 0.7,
  browserGateWrites: false,
};

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = envTrim(name);
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function readGateMode(fromFile: Partial<ActionGuardPolicy> | null): ActionGuardGateMode {
  const envMode = envTrim("JOSHU_ACTION_GUARD_GATE_MODE").toLowerCase();
  if (envMode === "allowlist" || envMode === "external_writes") return envMode;
  if (fromFile?.gateMode === "allowlist" || fromFile?.gateMode === "external_writes") {
    return fromFile.gateMode;
  }
  return DEFAULT_POLICY.gateMode;
}

function readPolicyFile(projectRoot: string): Partial<ActionGuardPolicy> | null {
  const file = actionGuardPolicyPath(projectRoot);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ActionGuardPolicy>;
  } catch {
    return null;
  }
}

/** Effective policy: env JOSHU_ACTION_GUARD_ENABLED overrides file `enabled`. */
export function loadActionGuardPolicy(projectRoot = process.cwd()): ActionGuardPolicy {
  const fromFile = readPolicyFile(projectRoot);
  const envEnabled = envTrim("JOSHU_ACTION_GUARD_ENABLED");
  const enabled =
    envEnabled.length > 0 ? envBool("JOSHU_ACTION_GUARD_ENABLED", false) : (fromFile?.enabled ?? false);

  const timeoutFromEnv = Number.parseInt(envTrim("JOSHU_ACTION_GUARD_TIMEOUT_MS"), 10);
  const approvalTimeoutMs =
    Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0
      ? timeoutFromEnv
      : (fromFile?.approvalTimeoutMs ?? DEFAULT_POLICY.approvalTimeoutMs);

  const guardedActions =
    fromFile?.guardedActions?.length ? fromFile.guardedActions : DEFAULT_POLICY.guardedActions;

  const bypassOwnerOnlyRecipients =
    fromFile?.bypassOwnerOnlyRecipients ??
    fromFile?.bypassSummaryEmailToOwner ??
    DEFAULT_POLICY.bypassOwnerOnlyRecipients;

  const llmClassifier = envTrim("JOSHU_ACTION_GUARD_LLM")
    ? envBool("JOSHU_ACTION_GUARD_LLM", false)
    : (fromFile?.llmClassifier ?? DEFAULT_POLICY.llmClassifier);

  const browserGateWrites = envTrim("JOSHU_ACTION_GUARD_BROWSER_GATE")
    ? envBool("JOSHU_ACTION_GUARD_BROWSER_GATE", false)
    : (fromFile?.browserGateWrites ?? DEFAULT_POLICY.browserGateWrites);

  const thresholdFromEnv = Number.parseFloat(envTrim("JOSHU_ACTION_GUARD_LLM_THRESHOLD"));
  const llmClassifierThreshold =
    Number.isFinite(thresholdFromEnv) && thresholdFromEnv > 0 && thresholdFromEnv <= 1
      ? thresholdFromEnv
      : (fromFile?.llmClassifierThreshold ?? DEFAULT_POLICY.llmClassifierThreshold);

  return {
    enabled,
    gateMode: readGateMode(fromFile),
    guardedActions,
    approvalTimeoutMs,
    bypassSummaryEmailToOwner: fromFile?.bypassSummaryEmailToOwner ?? bypassOwnerOnlyRecipients,
    bypassOwnerOnlyRecipients,
    llmClassifier,
    llmClassifierThreshold,
    browserGateWrites,
  };
}

export function isActionGuardEnabled(projectRoot = process.cwd()): boolean {
  const policyEnabled = loadActionGuardPolicy(projectRoot).enabled;
  if (!policyEnabled) return false;
  return isOwnerChannelLinked(projectRoot);
}

export function isActionGuarded(actionId: string, projectRoot = process.cwd()): boolean {
  const policy = loadActionGuardPolicy(projectRoot);
  if (!policy.enabled) return false;

  if (policy.gateMode === "external_writes") {
    if (isActionGuardedExternalWrites(actionId, policy)) return true;
  }

  if (actionId.startsWith("composio:")) {
    return isComposioToolGuarded(actionId.slice("composio:".length), policy.guardedActions);
  }

  if (actionId.startsWith("browser:")) {
    return policy.guardedActions.includes(actionId);
  }

  return (
    policy.guardedActions.includes(actionId) ||
    isConnectorsToolGuarded(actionId, policy.guardedActions)
  );
}

/** Resolve composio tool name to action id for guard checks. */
export function actionIdForComposioTool(toolName: string): string {
  return composioActionId(toolName);
}
