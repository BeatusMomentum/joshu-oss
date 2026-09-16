/**
 * Strip DeepSeek / Hermes model debris from assistant content streams.
 * DSML native tool markup and mcp__ tool names must never reach owners on any surface.
 */

/** DeepSeek sometimes emits native DSML tool markup in the content stream. */
const DSML_TAG_RE = /<\/?DSML[a-zA-Z0-9_-]*(?:\s[^>]*)?>/gi;
const DSML_BLOCK_RE = /<DSML[\s\S]*?(?:<\/DSML[a-zA-Z0-9_-]*>|$)/gi;
const MCP_TOOL_NAME_RE = /\bmcp__[a-z0-9_]+__\w+\b/gi;
const RESIDUAL_XML_TAG_RE = /<[^>\n]{0,200}>/g;

/** Hold back stream tail so a `<DSML…` tag split across deltas is not emitted early. */
const STREAM_HOLD_BACK_CHARS = 32;

/** Remove DSML / tool debris without normalizing whitespace (safe per stream delta). */
export function stripLeakedModelMarkupInPlace(raw: string): string {
  let text = raw.replace(DSML_BLOCK_RE, " ").replace(DSML_TAG_RE, " ");
  text = text.replace(MCP_TOOL_NAME_RE, " ");
  text = text.replace(RESIDUAL_XML_TAG_RE, " ");
  return text;
}

/** Batch scrub on a complete message — may collapse whitespace. */
export function stripLeakedModelMarkup(raw: string): string {
  return stripLeakedModelMarkupInPlace(raw).replace(/\s+/g, " ").trim();
}

/** True when model output is internal monologue / tool markup, not an owner reply. */
export function looksLikeLeakedModelOutput(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/<\/?DSML/i.test(t)) return true;
  if (/\bmcp__/.test(t)) return true;
  if (/\btool_call\b/i.test(t)) return true;

  const leakPhrases = [
    /Let me (?:reconcile|pass|construct|write|put|try)/i,
    /I need to pass the arguments/i,
    /arguments (?:field|parameter)/i,
    /(?:isn't|is not) serializ/i,
    /coming through empty/i,
    /Owner said no\./i,
    /Owner's declining/i,
  ];
  const hits = leakPhrases.filter((re) => re.test(t)).length;
  if (hits >= 2) return true;

  const words = t.split(/\s+/).filter((w) => /[a-zA-Z]{3,}/.test(w));
  if (words.length < 4 && t.length > 60) return true;
  return false;
}

/** Stateful scrubber for Hermes SSE content deltas (api_server / jChat / SMS). */
export class HermesStreamContentScrubber {
  private pending = "";

  reset(): void {
    this.pending = "";
  }

  feed(delta: string): string {
    if (!delta) return "";
    const buf = this.pending + delta;
    if (buf.length <= STREAM_HOLD_BACK_CHARS) {
      this.pending = buf;
      return "";
    }
    const safe = buf.slice(0, -STREAM_HOLD_BACK_CHARS);
    this.pending = buf.slice(-STREAM_HOLD_BACK_CHARS);
    return stripLeakedModelMarkupInPlace(safe);
  }

  flush(): string {
    const out = stripLeakedModelMarkupInPlace(this.pending);
    this.pending = "";
    return out;
  }
}

/** Scrub a complete assistant message (post-stream). */
export function scrubHermesAssistantContent(raw: string): string {
  return stripLeakedModelMarkup(raw);
}
