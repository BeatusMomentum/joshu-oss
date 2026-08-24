type CachedToolkitRow = {
  slug: string;
  name: string;
  logo?: string;
  isConnected: boolean;
  connectedAccountId?: string;
  connectedAccounts?: Array<{ connectedAccountId: string; label?: string }>;
};

const STORAGE_KEY = "joshu.connectors.toolkits.v1";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type StoredToolkits = {
  featured: CachedToolkitRow[];
  at: number;
};

export function readLocalToolkitsCache(): StoredToolkits | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredToolkits;
    if (!Array.isArray(parsed.featured) || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLocalToolkitsCache(featured: CachedToolkitRow[]): void {
  try {
    const payload: StoredToolkits = { featured, at: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}
