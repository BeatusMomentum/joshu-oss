/**
 * Proactive sweep helpers for ea-onboarding setup-debt cards.
 */
import { EA_ONBOARDING_KANBAN_BOARD } from "../hermesKanbanBridge.js";
import { listActiveOnboardingPrompts } from "./promptRegistry.js";
import { countOpenRequiredOnboardingPrompts } from "./promptPredicates.js";
import {
  isOnboardingKanbanBody,
  isPromptSnoozed,
  parseOnboardingPromptIdFromBody,
  readOnboardingPromptState,
} from "./promptState.js";

/** Score subtracted in rankCandidate — lower score wins. */
export const ONBOARDING_RANK_BOOST = 120;

/**
 * True when ea-onboarding should get rank boost in proactive sweep.
 * No time limit — any open required registry prompt keeps setup-debt priority
 * (new ship-with-release prompts can land long after Welcome).
 */
export async function isOnboardingSetupDebt(
  projectRoot: string,
  board: string,
): Promise<boolean> {
  if (board !== EA_ONBOARDING_KANBAN_BOARD) return false;
  const prompts = await listActiveOnboardingPrompts(projectRoot);
  const openRequired = await countOpenRequiredOnboardingPrompts(projectRoot, prompts);
  return openRequired > 0;
}

/** Skip proactive nudge for snoozed onboarding prompt cards. */
export function isOnboardingCandidateSuppressed(
  projectRoot: string,
  board: string,
  body: string | undefined,
): boolean {
  if (board !== EA_ONBOARDING_KANBAN_BOARD) return false;
  if (!isOnboardingKanbanBody(body)) return false;
  const promptId = parseOnboardingPromptIdFromBody(body);
  if (!promptId) return false;
  const state = readOnboardingPromptState(projectRoot);
  return isPromptSnoozed(state, promptId);
}
