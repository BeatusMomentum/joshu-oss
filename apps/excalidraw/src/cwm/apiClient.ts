import type {
  CwmActor,
  CwmAuthorityDecision,
  CwmEvent,
  CwmProposal,
  CwmSemanticOperation,
  CwmWorkspace,
} from "@joshu/whiteboard-cwm";

const CWM_API_PATH = "/joshu/api/excalidraw/cwm";

export function resolveCwmApiBase(location: Location = window.location): string {
  const fromEnv = import.meta.env.VITE_JOSHU_CWM_API_BASE?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  const { hostname, protocol, port } = location;
  if (port === "8787") return `${protocol}//${hostname}:8788${CWM_API_PATH}`;
  return CWM_API_PATH;
}

export class CwmApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "CwmApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ApiErrorBody {
  readonly error?: string;
  readonly code?: string;
  readonly details?: unknown;
}

interface BoardResponse {
  readonly ok: true;
  readonly path: string;
  readonly workspace: CwmWorkspace;
}

interface EventsResponse {
  readonly ok: true;
  readonly path: string;
  readonly headSequence: number;
  readonly events: readonly CwmEvent[];
}

export interface CwmMutationResult {
  readonly ok: true;
  readonly workspace: CwmWorkspace;
  readonly event: CwmEvent;
  readonly authority?: CwmAuthorityDecision;
  readonly proposal?: CwmProposal;
  readonly handoffPath?: string;
}

interface MutationBase {
  readonly path: string;
  readonly headSequence: number;
  readonly actor?: CwmActor;
}

export interface ProposeInput extends MutationBase {
  readonly operations: readonly CwmSemanticOperation[];
  readonly rationale?: string;
}

export interface ResolveProposalInput extends MutationBase {
  readonly proposalId: string;
  readonly reason?: string;
}

export interface CheckpointInput extends MutationBase {
  readonly scene: unknown;
  readonly reason?: string;
}

export interface ConsolidateInput extends MutationBase {
  readonly markdown: string;
  readonly fileName?: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
  if (!response.ok) {
    throw new CwmApiError(
      body.error ?? `Curatorial Whiteboard API returned HTTP ${response.status}`,
      response.status,
      body.code,
      body.details,
    );
  }
  return body as T;
}

export class CwmApiClient {
  readonly baseUrl: string;

  constructor(baseUrl = resolveCwmApiBase()) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async get<T>(
    route: string,
    query: Readonly<Record<string, string | number | undefined>>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${route}`, window.location.href);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return readJson<T>(await fetch(url, { signal }));
  }

  private async post<T>(route: string, body: unknown): Promise<T> {
    return readJson<T>(
      await fetch(`${this.baseUrl}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  getBoard(path: string, signal?: AbortSignal): Promise<BoardResponse> {
    return this.get("/board", { path }, signal);
  }

  getEvents(
    path: string,
    options: { afterSequence?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<EventsResponse> {
    return this.get("/events", { path, ...options }, signal);
  }

  createBoard(path: string): Promise<BoardResponse> {
    return this.post("/create", { path });
  }

  propose(input: ProposeInput): Promise<CwmMutationResult> {
    return this.post("/proposal", input);
  }

  confirm(input: ResolveProposalInput): Promise<CwmMutationResult> {
    return this.post("/confirm", input);
  }

  reject(input: ResolveProposalInput): Promise<CwmMutationResult> {
    return this.post("/reject", input);
  }

  checkpoint(input: CheckpointInput): Promise<CwmMutationResult> {
    return this.post("/checkpoint", input);
  }

  consolidate(input: ConsolidateInput): Promise<CwmMutationResult> {
    return this.post("/consolidate", input);
  }
}

export const cwmApiClient = new CwmApiClient();
