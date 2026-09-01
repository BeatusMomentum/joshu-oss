import type { ActionGuardGateMode } from "../actionGuard/policy.js";
import { ownerSmsPhone, twilioSmsGatewayEnabled } from "../twilioSmsSend.js";
import type { OwnerChannelConfig, OwnerChannelStatus } from "./types.js";
import { ensureOwnerChannelDir, ownerChannelConfigPath } from "./paths.js";
import fs from "node:fs";

export function readOwnerChannelConfig(projectRoot = process.cwd()): OwnerChannelConfig | null {
  const file = ownerChannelConfigPath(projectRoot);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OwnerChannelConfig>;
    return {
      provider: "sms",
      gateMode:
        parsed.gateMode === "allowlist" || parsed.gateMode === "external_writes"
          ? parsed.gateMode
          : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeOwnerChannelConfig(config: OwnerChannelConfig, projectRoot = process.cwd()): void {
  ensureOwnerChannelDir(projectRoot);
  const file = ownerChannelConfigPath(projectRoot);
  if (!file) throw new Error("Could not resolve owner-channel config path");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...config, provider: "sms" }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** Action-guard owner channel is linked when Twilio owner SMS is configured. */
export function isOwnerChannelLinked(projectRoot = process.cwd()): boolean {
  return twilioSmsGatewayEnabled(projectRoot);
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  return `***${digits.slice(-4)}`;
}

export function ownerChannelStatus(projectRoot = process.cwd()): OwnerChannelStatus {
  const linked = twilioSmsGatewayEnabled(projectRoot);
  const ownerPhone = ownerSmsPhone(projectRoot);
  const config = readOwnerChannelConfig(projectRoot);
  return {
    linked,
    provider: "sms",
    ownerPhone: ownerPhone ? maskPhone(ownerPhone) : undefined,
    gateMode: config?.gateMode,
  };
}

export function defaultOwnerChannelProvider(): "sms" {
  return "sms";
}

/** Legacy no-op — SMS uses Telephone owner mobile / TWILIO_OWNER_CALLER, not a stored link file. */
export function hydrateOwnerChannelFromLegacy(_projectRoot = process.cwd()): OwnerChannelConfig | null {
  return null;
}
