import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RECALL_CARD_TEXT,
  normalizeAndSelectRecallCards,
  normalizeRecallPayload,
  selectDiverseRecallCards,
} from "./retrieval";

test("normalizes changing Hindsight envelopes defensively and bounds text", () => {
  const cards = normalizeRecallPayload(
    {
      data: {
        memories: [
          {
            memory_id: "mem-1",
            memory: `A remembered constraint ${"x".repeat(900)}`,
            metadata: { ignored: true },
          },
          null,
          { unsupported: "shape" },
        ],
      },
    },
    "memory",
    "constraints",
  );

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.sourceId, "hindsight:mem-1");
  assert.equal(cards[0]?.sourceUri, "hindsight://memory/mem-1");
  assert.equal(cards[0]?.locator, "mem-1");
  assert.equal(cards[0]?.text.length, MAX_RECALL_CARD_TEXT);
});

test("dedupes equivalent evidence and preserves source diversity", () => {
  const selected = normalizeAndSelectRecallCards(
    {
      results: [
        { slug: "research/alpha", chunk_text: "Shared finding" },
        { slug: "research/beta", chunk_text: "File-only finding" },
        { slug: "research/gamma", chunk_text: "Another file finding" },
      ],
    },
    {
      items: [
        { id: "duplicate", text: " shared   finding " },
        { id: "memory-only", text: "Memory-only finding" },
      ],
    },
    "finding",
    4,
  );

  assert.deepEqual(
    selected.map((card) => card.source),
    ["file", "memory", "file", "file"],
  );
  assert.equal(selected.filter((card) => /shared finding/i.test(card.text)).length, 1);
});

test("caps total cards at six and requested limits at a minimum of one", () => {
  const cards = Array.from({ length: 10 }, (_, index) => ({
    source: "file" as const,
    sourceId: `gbrain:${index}`,
    sourceUri: `joshu://file-${index}`,
    locator: `file-${index}`,
    title: `File ${index}`,
    text: `Unique evidence ${index}`,
  }));

  assert.equal(selectDiverseRecallCards(cards, [], 99).length, 6);
  assert.equal(selectDiverseRecallCards(cards, [], 0).length, 1);
});
