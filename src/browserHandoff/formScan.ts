/**
 * Joshu-side structured LLM scan for the handoff overlay.
 *
 * Input is a sanitized field/button catalog (no live values). Owner-typed
 * overlay values must never be imported or concatenated here.
 */

import { day0ChatCompletion, isDay0LlmConfigured, parseLlmJson } from "../day0/llm.js";
import {
  catalogForScanPrompt,
  heuristicOverlayScan,
  mergeOverlayScan,
  type FormCatalog,
  type OverlayScan,
} from "./formCatalog.js";

export function isHandoffScanLlmConfigured(): boolean {
  return isDay0LlmConfigured();
}

export function buildHandoffScanPrompt(catalog: FormCatalog): { system: string; user: string } {
  const payload = catalogForScanPrompt(catalog);
  return {
    system: [
      "You label HTML form controls for a mobile overlay.",
      "Return JSON only: {\"fields\":[{\"id\",\"inputType\",\"label\"}],\"primaryButtonId\":string|null}.",
      "inputType must be one of: email, password, tel, text, number, select, checkbox, radio.",
      "Use only ids from the catalog. Do not invent controls.",
      "primaryButtonId is the catalog button the owner should press after fill (Continue, Sign in, Submit).",
      "If no safe primary button exists, set primaryButtonId to null.",
      "Never ask for or echo field values. The catalog has no values on purpose.",
    ].join(" "),
    user: JSON.stringify(payload),
  };
}

export async function scanCatalogWithLlm(catalog: FormCatalog): Promise<OverlayScan> {
  const fallback = heuristicOverlayScan(catalog);
  if (catalog.fields.length === 0) return fallback;
  if (!isHandoffScanLlmConfigured()) return fallback;

  const { system, user } = buildHandoffScanPrompt(catalog);
  try {
    const raw = await day0ChatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      {
        json: true,
        maxTokens: 1200,
        traceName: "handoff-form-scan",
        generationName: "handoff-form-scan",
        tags: ["browser-handoff", "form-scan"],
        metadata: { fieldCount: catalog.fields.length, buttonCount: catalog.buttons.length },
      },
    );
    const parsed = parseLlmJson<{
      fields?: Array<{ id?: unknown; inputType?: unknown; label?: unknown }>;
      primaryButtonId?: unknown;
    }>(raw);
    const merged = mergeOverlayScan(catalog, parsed);
    return { ...merged, source: "llm" };
  } catch {
    return fallback;
  }
}
