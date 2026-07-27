/**
 * Sync bundled ArozOS app skills into $HERMES_HOME/skills/apps/<appId>/ so
 * skill_view can load agent.skill names declared on joshu.app.json manifests.
 */

import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { registerAppSkill } from "./appSkillsRegistry.js";

export type AppSkillsSyncResult = {
  readonly hermesSkillsRoot: string;
  readonly copiedApps: readonly string[];
  readonly registeredSkills: readonly string[];
};

function hermesHomeDir(): string {
  return process.env.HERMES_HOME?.trim() || path.join(os.homedir(), ".hermes");
}

async function readManifestSkillName(manifestPath: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
      agent?: { skill?: unknown };
    };
    const skill = typeof raw.agent?.skill === "string" ? raw.agent.skill.trim() : "";
    return skill || undefined;
  } catch {
    return undefined;
  }
}

/** Copy every arozos/subservice/<app>/skills tree into Hermes and register agent.skill names. */
export async function syncBundledAppSkillsToHermes(
  projectRoot: string,
): Promise<AppSkillsSyncResult> {
  const subRoot = path.join(projectRoot, "arozos", "subservice");
  const hermesSkillsRoot = path.join(hermesHomeDir(), "skills", "apps");
  const copiedApps: string[] = [];
  const registeredSkills = new Set<string>();

  let entries: string[] = [];
  try {
    entries = await readdir(subRoot);
  } catch {
    return { hermesSkillsRoot, copiedApps, registeredSkills: [] };
  }

  await mkdir(hermesSkillsRoot, { recursive: true });

  for (const appId of entries) {
    const appDir = path.join(subRoot, appId);
    const skillsDir = path.join(appDir, "skills");
    try {
      if (!(await stat(appDir)).isDirectory()) continue;
      if (!(await stat(skillsDir)).isDirectory()) continue;
    } catch {
      continue;
    }

    const skillEntries = await readdir(skillsDir);
    if (!skillEntries.length) continue;

    const dest = path.join(hermesSkillsRoot, appId);
    await mkdir(dest, { recursive: true });
    await cp(skillsDir, dest, { recursive: true, force: true });
    copiedApps.push(appId);

    // Also install each skill at ~/.hermes/skills/joshu/<skill>/ so Hermes
    // discovers them beside other product skills (category/skill layout).
    const joshuCategory = path.join(hermesHomeDir(), "skills", "joshu");
    await mkdir(joshuCategory, { recursive: true });

    const fromManifest = await readManifestSkillName(path.join(appDir, "joshu.app.json"));
    if (fromManifest) {
      await registerAppSkill(projectRoot, fromManifest);
      registeredSkills.add(fromManifest);
    }

    // Also register any nested skill folder names (frontmatter may differ).
    for (const skillEntry of skillEntries) {
      const skillPath = path.join(skillsDir, skillEntry, "SKILL.md");
      try {
        if (!(await stat(skillPath)).isFile()) continue;
      } catch {
        continue;
      }
      await registerAppSkill(projectRoot, skillEntry);
      registeredSkills.add(skillEntry);
      await cp(path.join(skillsDir, skillEntry), path.join(joshuCategory, skillEntry), {
        recursive: true,
        force: true,
      });
    }
  }

  return {
    hermesSkillsRoot,
    copiedApps: copiedApps.sort(),
    registeredSkills: [...registeredSkills].sort(),
  };
}
