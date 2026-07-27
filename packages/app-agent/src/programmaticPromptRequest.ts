/** An app-originated user prompt. `id` is the idempotency key within one chat thread. */
export type JoshuProgrammaticPromptRequest = {
  id: string;
  text: string;
};

export type ClaimedProgrammaticPrompt = {
  id: string;
  text: string;
};

export type ProgrammaticPromptRequestGate = {
  claim: (
    scope: string,
    request: JoshuProgrammaticPromptRequest | null | undefined,
  ) => ClaimedProgrammaticPrompt | null;
};

/**
 * Build a bounded idempotency gate. The package-level gate survives React StrictMode remounts,
 * while callers can create isolated gates for tests.
 */
export function createProgrammaticPromptRequestGate(
  maxEntries = Number.POSITIVE_INFINITY,
): ProgrammaticPromptRequestGate {
  const claimed = new Set<string>();
  const order: string[] = [];

  return {
    claim(scope, request) {
      const id = request?.id.trim() ?? "";
      const text = request?.text.trim() ?? "";
      if (!scope || !id || !text) return null;

      const key = `${scope}\u0000${id}`;
      if (claimed.has(key)) return null;
      claimed.add(key);
      order.push(key);

      while (order.length > Math.max(1, maxEntries)) {
        const oldest = order.shift();
        if (oldest) claimed.delete(oldest);
      }
      return { id, text };
    },
  };
}

const sharedPromptRequestGate = createProgrammaticPromptRequestGate();

/** Claim an app-originated prompt once across rerenders and StrictMode remounts. */
export function claimProgrammaticPromptRequest(
  scope: string,
  request: JoshuProgrammaticPromptRequest | null | undefined,
): ClaimedProgrammaticPrompt | null {
  return sharedPromptRequestGate.claim(scope, request);
}
