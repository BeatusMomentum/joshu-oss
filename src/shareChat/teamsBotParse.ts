/**
 * Parse share UUID from Teams bot message text (bind command or share-chat URL).
 */

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

/** Strip @mentions Teams inserts as <at>Name</at> HTML entities. */
export function stripTeamsMentions(text: string): string {
  return String(text || "")
    .replace(/<at>[^<]*<\/at>/gi, "")
    .replace(/@[A-Za-z0-9._-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract a share UUID from user text.
 * Accepts: bare UUID, `bind <uuid>`, or `…/share-chat/<uuid>`.
 */
export function extractShareUuidFromTeamsText(text: string): string | null {
  const raw = stripTeamsMentions(text);
  if (!raw) return null;

  const bind = raw.match(/^(?:\/)?bind\s+(.+)$/i);
  const hay = (bind?.[1] || raw).trim();

  const fromPath = hay.match(/share-chat\/([0-9a-f-]{36})/i);
  if (fromPath?.[1] && UUID_RE.test(fromPath[1])) {
    return fromPath[1].toLowerCase();
  }

  const bare = hay.match(UUID_RE);
  if (bare?.[0]) return bare[0].toLowerCase();
  return null;
}

export function isTeamsBindCommand(text: string): boolean {
  const raw = stripTeamsMentions(text);
  return /^(?:\/)?bind\b/i.test(raw) || /share-chat\/[0-9a-f-]{36}/i.test(raw);
}
