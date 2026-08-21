/**
 * Teams app package (manifest + icons) for sideloading the Share Chat bot.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { resolveJoshuIdentity } from "../joshuIdentity.js";
import { resolveTeamsBotCreds } from "./teamsBotCreds.js";
import { teamsBotMessagesRequestUrl, teamsBotMessagesUrlIsPublic } from "./teamsBotUrl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function teamsBotAssetsDir(): string {
  const candidates = [
    path.join(__dirname, "teamsBotAssets"),
    path.join(process.cwd(), "src/shareChat/teamsBotAssets"),
    path.join(process.cwd(), "dist/shareChat/teamsBotAssets"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "color.png"))) return dir;
  }
  return candidates[0] ?? path.join(process.cwd(), "src/shareChat/teamsBotAssets");
}

export function buildTeamsBotManifest(opts: {
  appId: string;
  botName: string;
  description?: string;
}): Record<string, unknown> {
  const name = (opts.botName || "Joshu Files").slice(0, 30);
  const fullName = (opts.botName || name).slice(0, 100);
  const description = (
    opts.description ||
    "Answers questions about shared files (Joshu Share Chat). Sideload only — not a Store app."
  ).slice(0, 4000);
  const shortDesc = description.slice(0, 80);

  return {
    $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
    manifestVersion: "1.17",
    version: "1.0.0",
    id: opts.appId,
    developer: {
      name: "Joshu",
      websiteUrl: "https://joshu.me",
      privacyUrl: "https://joshu.me/privacy",
      termsOfUseUrl: "https://joshu.me/terms",
    },
    name: {
      short: name,
      full: fullName,
    },
    description: {
      short: shortDesc,
      full: description,
    },
    icons: {
      color: "color.png",
      outline: "outline.png",
    },
    accentColor: "#2563EB",
    bots: [
      {
        botId: opts.appId,
        scopes: ["personal", "groupChat"],
        supportsFiles: false,
        isNotificationOnly: false,
        // Free Teams: group chats typically require @mention
      },
    ],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: [],
  };
}

export function teamsBotManifestForProject(projectRoot = process.cwd()): Record<string, unknown> {
  const creds = resolveTeamsBotCreds(projectRoot);
  const identity = resolveJoshuIdentity(projectRoot);
  const companion = (creds?.displayName || identity.name || "Joshu").trim() || "Joshu";
  const appId = creds?.appId || "00000000-0000-0000-0000-000000000000";
  return buildTeamsBotManifest({
    appId,
    botName: `${companion} Files`.slice(0, 30),
    description: `${companion} answers questions about shared files in Teams (scoped Share Chat only).`,
  });
}

/** Zip manifest + icons for Teams → Upload a custom app. */
export async function buildTeamsBotPackageZip(
  projectRoot = process.cwd(),
): Promise<Buffer> {
  const creds = resolveTeamsBotCreds(projectRoot);
  if (!creds?.appId) throw new Error("teams_bot_not_configured");

  const manifest = teamsBotManifestForProject(projectRoot);
  const assets = teamsBotAssetsDir();
  const colorPath = path.join(assets, "color.png");
  const outlinePath = path.join(assets, "outline.png");
  if (!fs.existsSync(colorPath) || !fs.existsSync(outlinePath)) {
    throw new Error("teams_bot_icons_missing");
  }

  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("color.png", fs.readFileSync(colorPath));
  zip.file("outline.png", fs.readFileSync(outlinePath));
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return Buffer.from(buf);
}

export type TeamsBotSetupStatus = {
  /** Connectors UI section — gated by JOSHU_TEAMS_BOT_UI_ENABLED (default off). */
  uiEnabled: boolean;
  configured: boolean;
  appIdPreview?: string;
  messagesUrl: string;
  messagesUrlIsPublic: boolean;
  setupRequired: boolean;
  steps: string[];
};

function previewId(id: string): string {
  if (id.length <= 10) return `${id.slice(0, 4)}…`;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/**
 * Feature flag for the Connectors → Teams bot setup card.
 * Messaging / bind APIs stay available when credentials are already configured.
 * Default: hidden until explicitly enabled.
 */
export function isTeamsBotUiEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.JOSHU_TEAMS_BOT_UI_ENABLED?.trim() || "");
}

export function getTeamsBotSetupStatus(projectRoot = process.cwd()): TeamsBotSetupStatus {
  const creds = resolveTeamsBotCreds(projectRoot);
  const messagesUrl = teamsBotMessagesRequestUrl();
  const messagesUrlIsPublic = teamsBotMessagesUrlIsPublic();
  const configured = Boolean(creds?.appId && creds.appPassword);
  const uiEnabled = isTeamsBotUiEnabled();
  return {
    uiEnabled,
    configured,
    appIdPreview: creds?.appId ? previewId(creds.appId) : undefined,
    messagesUrl,
    messagesUrlIsPublic,
    setupRequired: uiEnabled && !configured,
    steps: [
      "Create an Azure Bot (F0) + Entra app registration (multi-tenant / personal accounts OK for free Teams sideload).",
      "Azure Bot → Channels → enable Microsoft Teams.",
      "Azure Bot → Configuration → Messaging endpoint: paste the URL Joshu shows below (must be public HTTPS).",
      "Copy Application (client) ID and a client secret into Connectors → Teams bot → Save.",
      "Download the Teams app package zip → Teams → Apps → Manage your apps → Upload a custom app.",
      "Open a chat with the bot (or add it to a group), then from Chat sharing copy the bind command / Share Chat URL into that chat.",
    ],
  };
}
