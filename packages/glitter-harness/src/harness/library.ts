import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TIERS } from "./providers.js";
import { harnessDir, type SessionMeta } from "./store.js";

/**
 * The model library: the models the user added, with the metadata they chose.
 * The picker lists library models instead of every model a provider lists, so
 * what a thread can use is exactly what the user put here. A field the user
 * left unset stays unset, and the learned window, the live catalog row and the
 * family table still answer for it; a field they set wins over all of them.
 *
 * The file lives beside the session store, written 0600 like the session logs.
 * The harness host process is its only writer — the renderer edits the library
 * through bridge verbs — so writes need no cross-process lock.
 */

export type UserModelEntry = {
  /** The provider the model comes from: a built-in id or a minted `custom-N`. */
  providerId: string;
  /** The model's id at that provider, without the provider prefix. May itself contain slashes (gateways). */
  model: string;
  displayName?: string;
  /** Input window in tokens. Unset or null is unknown: learned, catalog and family still apply. */
  contextWindow?: number | null;
  /** Effort levels the model accepts, from the app's tier vocabulary. Unset means not chosen; empty means none. */
  efforts?: string[];
  defaultEffort?: string;
  /** Modality support the user chose. Unset or null is unknown: the family heuristic still applies to images. */
  images?: boolean | null;
  documents?: boolean | null;
  video?: boolean | null;
  /** Per-million prices carried from the provider listing at add time, for display only. */
  cost?: { input?: string; output?: string; currency?: string | null } | null;
  /** Whether the user set the effort levels themselves or they came from the provider listing. */
  effortSource?: "fetched" | "user";
  /** Where the entry came from: added in Settings, or seeded once from past threads. */
  source: "user" | "migrated";
  addedAt: string;
};

export const MAX_LIBRARY_MODELS = 500;
const MAX_MODEL_LENGTH = 200;
const MAX_NAME_LENGTH = 120;
const MAX_CONTEXT_WINDOW = 100_000_000;

/** The library is keyed by the full model id the rest of the harness uses (`provider/model`). */
export function entryKey(entry: Pick<UserModelEntry, "providerId" | "model">): string {
  return `${entry.providerId}/${entry.model}`;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function cleanWindow(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value > 0 && value <= MAX_CONTEXT_WINDOW ? value : undefined;
}

function cleanFlag(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  return typeof value === "boolean" ? value : undefined;
}

/** Effort levels come from the app's own tier vocabulary; a level the wire cannot express is not offered. */
function cleanEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tier = item.trim().toLowerCase();
    if ((TIERS as readonly string[]).includes(tier)) seen.add(tier);
  }
  return TIERS.filter((tier) => seen.has(tier));
}

function cleanCost(value: unknown): UserModelEntry["cost"] {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const row = value as { input?: unknown; output?: unknown; currency?: unknown };
  const price = (item: unknown) => typeof item === "string" && item.trim() ? item.trim().slice(0, 40) : undefined;
  const input = price(row.input);
  const output = price(row.output);
  const currency = typeof row.currency === "string" ? row.currency.slice(0, 8) : null;
  if (!input && !output) return null;
  return { ...(input ? { input } : {}), ...(output ? { output } : {}), currency };
}

export function normalizeEntry(value: unknown): UserModelEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const providerId = cleanText(row.providerId, 64);
  const model = cleanText(row.model, MAX_MODEL_LENGTH);
  if (!providerId || !model || /[\s\u0000]/.test(model)) return null;
  if (row.source !== "user" && row.source !== "migrated") return null;
  const addedAt = typeof row.addedAt === "string" && row.addedAt ? row.addedAt.slice(0, 40) : new Date(0).toISOString();
  const efforts = cleanEfforts(row.efforts);
  const defaultEffort = cleanText(row.defaultEffort, 32)?.toLowerCase();
  const entry: UserModelEntry = {
    providerId,
    model,
    ...(cleanText(row.displayName, MAX_NAME_LENGTH) ? { displayName: cleanText(row.displayName, MAX_NAME_LENGTH) } : {}),
    ...(row.contextWindow !== undefined ? { contextWindow: cleanWindow(row.contextWindow) } : {}),
    ...(efforts ? { efforts } : {}),
    ...(defaultEffort && efforts?.includes(defaultEffort) ? { defaultEffort } : {}),
    ...(row.images !== undefined ? { images: cleanFlag(row.images) } : {}),
    ...(row.documents !== undefined ? { documents: cleanFlag(row.documents) } : {}),
    ...(row.video !== undefined ? { video: cleanFlag(row.video) } : {}),
    ...(row.cost !== undefined ? { cost: cleanCost(row.cost) } : {}),
    ...(row.effortSource === "fetched" || row.effortSource === "user" ? { effortSource: row.effortSource } : {}),
    source: row.source,
    addedAt,
  };
  return entry;
}

/** Parse, clean and dedupe the file's contents; junk rows drop out rather than failing the library. */
export function normalizeLibrary(value: unknown): UserModelEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: UserModelEntry[] = [];
  for (const row of value) {
    const entry = normalizeEntry(row);
    if (!entry) continue;
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= MAX_LIBRARY_MODELS) break;
  }
  return entries;
}

export function libraryFile(root = harnessDir()): string {
  return join(root, "models.json");
}

export async function loadLibrary(root = harnessDir()): Promise<UserModelEntry[]> {
  let contents: string;
  try {
    contents = await readFile(libraryFile(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Cannot read the model library at ${libraryFile(root)}.`, { cause: error });
  }
  try {
    return normalizeLibrary(JSON.parse(contents));
  } catch {
    // A damaged file empties the library rather than failing every call; the next save rewrites it.
    return [];
  }
}

export async function saveLibrary(entries: readonly UserModelEntry[], root = harnessDir()): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = libraryFile(root);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * One-time seed: the models past threads actually used, including the roles a
 * thread's Orchestrator ran and the manual model it remembers. Nothing is
 * invented — a thread's model becomes a library entry, everything else waits
 * for the user to add it.
 */
export function seedFromSessions(sessions: readonly SessionMeta[], now = new Date().toISOString()): UserModelEntry[] {
  const ids = new Set<string>();
  for (const meta of sessions) {
    for (const id of [meta.modelId, meta.manual?.modelId, meta.orchestrator?.roles.lead?.modelId, meta.orchestrator?.roles.builder?.modelId, meta.orchestrator?.roles.small?.modelId, meta.orchestrator?.roles.router?.modelId]) {
      if (typeof id === "string" && id.includes("/")) ids.add(id.trim());
    }
  }
  const addedAt = now;
  return [...ids].sort().slice(0, MAX_LIBRARY_MODELS).map((id) => {
    const slash = id.indexOf("/");
    return normalizeEntry({ providerId: id.slice(0, slash), model: id.slice(slash + 1), source: "migrated", addedAt })!;
  }).filter((entry): entry is UserModelEntry => Boolean(entry));
}
