import { normalizeLineComments, type LineComment } from "./lineComments";
import { RECENT_COMMANDS_MAX } from "./palette";
import { normalizeZoom } from "./zoom";
import { normalizeDockWidth, normalizeSidebarWidth, DOCK_DEFAULT_WIDTH } from "./reviewLayout";
import { SETTINGS_TABS, type ComposerImage, type ContextRef, type SessionConfig, type SettingsTab, type SubscriptionUsage, type ThreadWorktree } from "./types";

export type Draft = {
  text: string;
  /**
   * Attachments whose bytes are still in memory. `persistableDrafts` empties
   * this for the settings document — image payloads in drafts used to push the
   * whole `glitter.json` past the 48 MiB IPC body limit, freezing every
   * save (drafts, titles, settings) rather than just dropping the bytes.
   */
  images: ComposerImage[];
  /**
   * References kept in place of stripped attachments: the name and media type
   * survive a restart, the bytes never do. Hydration reports them so the user
   * knows what to re-attach.
   */
  droppedImages?: DraftImageRef[];
  config?: SessionConfig;
  refs?: ContextRef[];
  /** A workspace draft that starts its thread in a new worktree. An empty base means the current branch. */
  worktree?: { base: string };
};

/** An attachment's identity without its bytes — what survives the settings document. */
export type DraftImageRef = { mediaType: string; name: string };

const asImageRef = (value: unknown): DraftImageRef | null => {
  if (!value || typeof value !== "object") return null;
  const { mediaType, name } = value as Partial<DraftImageRef>;
  return typeof mediaType === "string" && typeof name === "string" ? { mediaType, name } : null;
};

const isImageWithBytes = (value: unknown): value is ComposerImage =>
  Boolean(value && typeof value === "object" && typeof (value as ComposerImage).base64Data === "string" && (value as ComposerImage).base64Data);

/**
 * Rebuild one persisted draft: `images` entries carrying `base64Data` are this
 * session's live attachments and restore whole; entries already reduced to a
 * reference (written by a newer build, or a previous save) land in
 * `droppedImages` so the user can be told the bytes did not come back.
 */
export function normalizeDraft(value: unknown): Draft {
  const draft = (value && typeof value === "object" ? value : {}) as Partial<Draft>;
  const images: ComposerImage[] = [];
  const droppedImages: DraftImageRef[] = [];
  for (const image of Array.isArray(draft.images) ? draft.images : []) {
    if (isImageWithBytes(image)) images.push({ mediaType: image.mediaType, base64Data: image.base64Data, name: image.name });
    else {
      const ref = asImageRef(image);
      if (ref) droppedImages.push(ref);
    }
  }
  for (const ref of Array.isArray(draft.droppedImages) ? draft.droppedImages : []) {
    const parsed = asImageRef(ref);
    if (parsed) droppedImages.push(parsed);
  }
  return {
    text: typeof draft.text === "string" ? draft.text : "",
    images,
    ...(droppedImages.length ? { droppedImages } : {}),
    ...(draft.config ? { config: draft.config } : {}),
    ...(draft.refs ? { refs: draft.refs } : {}),
    ...(draft.worktree ? { worktree: draft.worktree } : {}),
  };
}

export function normalizeDrafts(value: unknown): Record<string, Draft> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, draft]) => [key, normalizeDraft(draft)]));
}

/**
 * The settings-document form of the in-memory drafts: attachment bytes stay in
 * memory only, replaced by name/type references. This is what keeps a 4×10 MB
 * draft from taking the whole document over the IPC limit with it.
 */
export function persistableDrafts(drafts: Record<string, Draft>): Record<string, Draft> {
  return Object.fromEntries(Object.entries(drafts).map(([key, draft]) => {
    const droppedImages = [...(draft.droppedImages ?? []), ...draft.images.map(({ mediaType, name }) => ({ mediaType, name }))];
    return [key, { ...draft, images: [], ...(droppedImages.length ? { droppedImages } : { droppedImages: undefined }) }];
  }));
}

export type ThreadMeta = {
  title?: string;
  agentId?: string;
  customTitle?: boolean;
  pinned?: boolean;
  order?: number;
  archived?: boolean;
  /** Locally removed; skip this session if the host lists it again. */
  deleted?: boolean;
  lastStatus?: "idle" | "running" | "error";
  lastOutcome?: "completed" | "failed" | "cancelled" | "interrupted";
  forkedFrom?: { sessionId: string; title: string; cutTurnId?: string; firstMessage?: boolean } | null;
  /** Kept here because the CLI lists a worktree session under the worktree's root, not the workspace's. */
  worktree?: ThreadWorktree;
};

/**
 * Bump only together with a step in `migrateMemory`. A document whose version
 * is newer than this build is shown from the fields we understand and is never
 * written back, so a downgrade cannot replace it with this version.
 */
export const SESSION_MEMORY_VERSION = 1;

/** Thrown when this build would replace a document written by a newer one. */
export class NewerSessionMemoryError extends Error {
  constructor(loadedVersion: number) {
    super(`Session memory is version ${loadedVersion}; this build writes version ${SESSION_MEMORY_VERSION} and will not replace it.`);
    this.name = "NewerSessionMemoryError";
  }
}

/** Missing or corrupt versions are the current document. Only a greater integer is "newer". */
export function documentVersion(value: unknown): number {
  if (!value || typeof value !== "object") return SESSION_MEMORY_VERSION;
  const version = (value as { version?: unknown }).version;
  return typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : SESSION_MEMORY_VERSION;
}

/**
 * In-order migrations live here. A newer document is returned unchanged so the
 * caller can refuse to save over it.
 */
export function migrateMemory(value: Partial<SessionMemory> | undefined): Partial<SessionMemory> | undefined {
  if (!value) return value;
  if (documentVersion(value) > SESSION_MEMORY_VERSION) return value;
  return { ...value, version: SESSION_MEMORY_VERSION };
}

export type SessionMemory = {
  version: number;
  selectedWorkspaceId: string | null;
  selectedSessionId: string | null;
  drafts: Record<string, Draft>;
  threadMeta: Record<string, ThreadMeta>;
  promptHistory: Record<string, string[]>;
  /** Diff line comments not yet sent, per thread or workspace draft. */
  lineComments: Record<string, LineComment[]>;
  /** Palette command ids, most recent first. */
  recentCommands: string[];
  settingsTab: SettingsTab;
  dockOpen: boolean;
  dockWidth: number;
  /** Interface zoom; 1 is actual size. */
  zoom: number;
  sidebarCollapsed: boolean;
  /** The dragged sidebar width; null keeps the default. */
  sidebarWidth: number | null;
  subscriptionUsage: SubscriptionUsage | null;
};

export const EMPTY_MEMORY: SessionMemory = {
  version: SESSION_MEMORY_VERSION,
  selectedWorkspaceId: null,
  selectedSessionId: null,
  drafts: {},
  threadMeta: {},
  promptHistory: {},
  lineComments: {},
  recentCommands: [],
  settingsTab: "Models",
  dockOpen: true,
  dockWidth: DOCK_DEFAULT_WIDTH,
  zoom: 1,
  sidebarCollapsed: false,
  sidebarWidth: null,
  subscriptionUsage: null,
};

type Store = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<unknown>;
  save(): Promise<unknown>;
};

/** Account was folded into Agents, where Muse's connection now lives with the other agents. */
function settingsTabOf(saved: string | undefined): SettingsTab {
  if (saved === "Account") return "Agents";
  return SETTINGS_TABS.find((tab) => tab === saved) ?? "Models";
}

export function normalizeMemory(value: Partial<SessionMemory> | undefined): SessionMemory {
  const migrated = migrateMemory(value);
  const version = documentVersion(migrated);
  return {
    ...EMPTY_MEMORY,
    ...migrated,
    // A newer document keeps its version so a save can refuse the downgrade.
    version: version > SESSION_MEMORY_VERSION ? version : SESSION_MEMORY_VERSION,
    settingsTab: settingsTabOf(migrated?.settingsTab),
    drafts: normalizeDrafts(migrated?.drafts),
    threadMeta: migrated?.threadMeta ?? {},
    promptHistory: normalizePromptHistory(migrated?.promptHistory),
    lineComments: normalizeLineComments(migrated?.lineComments),
    recentCommands: Array.isArray(migrated?.recentCommands) ? migrated.recentCommands.filter((id): id is string => typeof id === "string").slice(0, RECENT_COMMANDS_MAX) : [],
    dockWidth: normalizeDockWidth(migrated?.dockWidth),
    sidebarWidth: normalizeSidebarWidth(migrated?.sidebarWidth),
    zoom: normalizeZoom(migrated?.zoom),
  };
}

export class SessionMemoryPersistence {
  /** Saves run in call order so a stale document can never rename over a newer one. */
  private pending: Promise<void> = Promise.resolve();
  /** Version last read from disk. A newer document is not rewritten by this build. */
  private loadedVersion = SESSION_MEMORY_VERSION;

  constructor(private store: Store | null, private fallback?: Storage | null) {}

  async load(): Promise<SessionMemory> {
    if (this.store) {
      const saved = await this.store.get<Partial<SessionMemory>>("sessionMemory");
      this.loadedVersion = documentVersion(saved);
      return normalizeMemory(saved);
    }
    if (this.fallback) {
      try {
        const raw = this.fallback.getItem("glitter-session-memory");
        const parsed = raw ? JSON.parse(raw) as Partial<SessionMemory> : undefined;
        this.loadedVersion = documentVersion(parsed);
        return normalizeMemory(parsed);
      } catch {
        return { ...EMPTY_MEMORY };
      }
    }
    return { ...EMPTY_MEMORY };
  }

  async save(value: SessionMemory): Promise<void> {
    if (this.loadedVersion > SESSION_MEMORY_VERSION) {
      throw new NewerSessionMemoryError(this.loadedVersion);
    }
    const memory = normalizeMemory(value);
    // Byte-freedom is enforced here, not only at the store's persist site: no
    // caller may put base64 attachments into the settings document and push it
    // past the IPC body limit. Loading stays lenient — a document written by an
    // older build may still carry bytes, and those images restore once; the
    // next save writes only their references.
    const guarded = { ...memory, drafts: persistableDrafts(memory.drafts) };
    // Queue behind any in-flight save: without ordering, two racing saves can
    // reach the native writer in either order and an older document can win.
    const run = this.pending.then(async () => {
      if (this.store) {
        await this.store.set("sessionMemory", guarded);
        await this.store.save();
        return;
      }
      this.fallback?.setItem("glitter-session-memory", JSON.stringify(guarded));
    });
    this.pending = run.catch(() => {});
    return run;
  }
}

/** Only acknowledged, text-only prompt history; attachments remain in drafts. */
export function rememberPrompt(history: Record<string, string[]>, workspaceId: string, text: string): Record<string, string[]> {
  const prompt = text.trim();
  if (!prompt || history[workspaceId]?.[history[workspaceId].length - 1] === prompt) return history;
  return { ...history, [workspaceId]: [...(history[workspaceId] ?? []), prompt].slice(-50) };
}

function normalizePromptHistory(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([id, prompts]) => [id,
    Array.isArray(prompts) ? prompts.filter((text): text is string => typeof text === "string" && Boolean(text.trim())).slice(-50) : [],
  ]));
}
