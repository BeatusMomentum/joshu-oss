export const MAX_RECALL_CARDS = 6;
export const MAX_RECALL_CARD_TEXT = 600;

export type RecallSource = "file" | "memory";

export interface RecallSourceCard {
  readonly source: RecallSource;
  readonly sourceId: string;
  readonly sourceUri: string;
  readonly locator: string;
  readonly title: string;
  readonly text: string;
}

type UnknownRecord = Record<string, unknown>;

const ARRAY_KEYS = ["hits", "results", "items", "memories", "data", "documents", "chunks"] as const;
const TEXT_KEYS = [
  "chunk_text",
  "snippet",
  "content",
  "text",
  "memory",
  "body",
  "answer",
  "summary",
  "fact",
] as const;
const TITLE_KEYS = ["title", "name", "subject", "slug"] as const;
const ID_KEYS = ["sourceId", "source_id", "memory_id", "document_id", "id", "slug", "path"] as const;
const URI_KEYS = ["sourceUri", "source_uri", "uri", "url", "path", "slug"] as const;
const LOCATOR_KEYS = ["locator", "path", "slug", "document_id", "memory_id", "id"] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, limit = MAX_RECALL_CARD_TEXT): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function firstText(record: UnknownRecord, keys: readonly string[], limit?: number): string {
  for (const key of keys) {
    const value = boundedText(record[key], limit);
    if (value) return value;
  }
  return "";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Pull likely result records from unknown API envelopes while bounding traversal. Hindsight has
 * changed response envelopes across versions, so no particular nesting shape is trusted.
 */
function candidateRecords(payload: unknown): UnknownRecord[] {
  const candidates: UnknownRecord[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  let visited = 0;

  while (queue.length && visited < 100 && candidates.length < 24) {
    const next = queue.shift()!;
    visited += 1;
    if (Array.isArray(next.value)) {
      for (const item of next.value.slice(0, 24)) queue.push({ value: item, depth: next.depth + 1 });
      continue;
    }
    if (!isRecord(next.value)) continue;
    const record = next.value;

    const hasText = TEXT_KEYS.some((key) => Boolean(boundedText(record[key])));
    if (hasText) candidates.push(record);
    if (next.depth >= 4) continue;
    for (const key of ARRAY_KEYS) {
      const child = record[key];
      if (Array.isArray(child) || isRecord(child)) {
        queue.push({ value: child, depth: next.depth + 1 });
      }
    }
  }
  return candidates;
}

function sourceUri(source: RecallSource, raw: string, query: string, id: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw.slice(0, 2_000);
  if (source === "file" && raw) {
    return `joshu://${raw.replace(/^\/+/, "")}`.slice(0, 2_000);
  }
  if (source === "memory" && raw) {
    return `hindsight://memory/${encodeURIComponent(raw)}`.slice(0, 2_000);
  }
  if (source === "memory") {
    return `hindsight://memory/${encodeURIComponent(id)}`.slice(0, 2_000);
  }
  return `${source === "file" ? "joshu://brain/query" : "hindsight://recall"}?q=${encodeURIComponent(query)}#${encodeURIComponent(id)}`.slice(
    0,
    2_000,
  );
}

/** Normalize one source without throwing on malformed or partially unknown records. */
export function normalizeRecallPayload(
  payload: unknown,
  source: RecallSource,
  query: string,
): RecallSourceCard[] {
  const cards: RecallSourceCard[] = [];
  for (const [index, record] of candidateRecords(payload).entries()) {
    const text = firstText(record, TEXT_KEYS, MAX_RECALL_CARD_TEXT);
    if (!text || /^no matching (content|files?) found/i.test(text)) continue;
    const rawId = firstText(record, ID_KEYS, 256);
    const locator = firstText(record, LOCATOR_KEYS, 512) || `query:${boundedText(query, 400)}`;
    const id = rawId || `${source}-${stableHash(`${locator}:${text}`)}`;
    const rawUri = firstText(record, URI_KEYS, 2_000);
    cards.push({
      source,
      sourceId: `${source === "file" ? "gbrain" : "hindsight"}:${id}`.slice(0, 128),
      sourceUri: sourceUri(source, rawUri, query, id),
      locator,
      title:
        firstText(record, TITLE_KEYS, 120) ||
        `${source === "file" ? "File evidence" : "Memory evidence"} ${index + 1}`,
      text,
    });
  }
  return cards.slice(0, 24);
}

function dedupeKey(card: RecallSourceCard): string {
  return card.text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Dedupe and alternate sources so both file evidence and conversation memory are represented
 * whenever both returned usable cards.
 */
export function selectDiverseRecallCards(
  fileCards: readonly RecallSourceCard[],
  memoryCards: readonly RecallSourceCard[],
  requestedLimit = MAX_RECALL_CARDS,
): RecallSourceCard[] {
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_RECALL_CARDS, Math.trunc(requestedLimit)))
    : MAX_RECALL_CARDS;
  const seen = new Set<string>();
  const queues = [fileCards, memoryCards].map((cards) =>
    cards.filter((card) => {
      const key = dedupeKey(card);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
  const result: RecallSourceCard[] = [];
  let cursor = queues[0]!.length ? 0 : 1;

  while (result.length < limit && (queues[0]!.length || queues[1]!.length)) {
    const queue = queues[cursor]!;
    const card = queue.shift();
    if (card) result.push(card);
    cursor = cursor === 0 ? 1 : 0;
    if (!queues[cursor]!.length && queues[cursor === 0 ? 1 : 0]!.length) {
      cursor = cursor === 0 ? 1 : 0;
    }
  }
  return result;
}

export function normalizeAndSelectRecallCards(
  filePayload: unknown,
  memoryPayload: unknown,
  query: string,
  limit?: number,
): RecallSourceCard[] {
  return selectDiverseRecallCards(
    normalizeRecallPayload(filePayload, "file", query),
    normalizeRecallPayload(memoryPayload, "memory", query),
    limit,
  );
}
