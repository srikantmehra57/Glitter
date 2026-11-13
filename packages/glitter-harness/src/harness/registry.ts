import type { ToolGuard } from "./permission/guards.js";
import type { ToolDefinition, ToolOutcome } from "./tools.js";
import type { ToolSchema } from "./wire.js";

/**
 * The harness's extension surface. An extension contributes tools, system
 * prompt sections and hook handlers. The host takes a snapshot when a turn
 * starts and works only from it, so registering or removing an extension never
 * changes a turn that is already running. This is a registry, not a runtime:
 * extensions are plain objects, registered in order, with no loading or DI.
 */

/** What a contribution may look at when a turn starts. `delegationDepth` is 0 for a top-level thread. */
export type TurnContext = Readonly<{ sessionId: string; turnId: string; workspaceRoot: string; mode: "build" | "plan"; delegationDepth: number }>;

/** A tool that exists only for the turns it returns a definition for. */
export type ToolFactory = (context: TurnContext) => ToolDefinition | readonly ToolDefinition[] | undefined;

/** `stable` sections join the cached prefix; `volatile` ones follow the date and mode. */
export type PromptContribution = {
  placement: "stable" | "volatile";
  text: string | ((context: TurnContext) => string | undefined);
};

export type HookCall = Readonly<{ id: string; name: string; input: Readonly<Record<string, unknown>> }>;

/** Hook events and their payloads. Adding an event is one line here and one `runHook` call in the host. */
export type HookEvents = {
  turnStarted: { context: TurnContext };
  toolStarting: { context: TurnContext; call: HookCall };
  toolFinished: { context: TurnContext; call: HookCall; outcome: ToolOutcome };
  turnFinished: { context: TurnContext; outcome: Readonly<Record<string, unknown>> };
};

export type HookName = keyof HookEvents;
export type HookTable = { [E in HookName]?: (payload: HookEvents[E]) => void | Promise<void> };

export type Extension = {
  id: string;
  tools?: ReadonlyArray<ToolDefinition | ToolFactory>;
  prompt?: readonly PromptContribution[];
  /** Observers only. A handler cannot change or refuse what the turn does. */
  hooks?: HookTable;
  /** Deny-only checks every call passes before the permission mode is consulted. */
  guards?: readonly ToolGuard[];
  /** Named tool subsets, such as the narrowed set a delegated task gets. */
  profiles?: Readonly<Record<string, readonly string[]>>;
};

/** A hook handler that threw. The turn carries on; the host reports it. */
export type HookFailure = { extensionId: string; hook: HookName; message: string };

/** Everything one turn may use, fixed when the turn started. */
export type TurnContributions = Readonly<{
  context: TurnContext;
  tools: ReadonlyMap<string, ToolDefinition>;
  schemas: readonly ToolSchema[];
  guards: readonly ToolGuard[];
  prompt: Readonly<{ stable: readonly string[]; volatile: readonly string[] }>;
  runHook: <E extends HookName>(hook: E, payload: HookEvents[E]) => Promise<HookFailure[]>;
}>;

export class ExtensionRegistry {
  private readonly extensions = new Map<string, Extension>();

  /**
   * Add an extension, or throw and add nothing. Static tool names and profile
   * ids must be unique across extensions; a factory's names are checked when a
   * turn starts. Returns a function that removes the extension again.
   */
  register(extension: Extension): () => void {
    if (!extension.id) throw new Error("An extension needs an id.");
    if (this.extensions.has(extension.id)) throw new Error(`An extension named ${extension.id} is already registered.`);
    const taken = new Map<string, string>();
    const profiles = new Set<string>();
    for (const existing of this.extensions.values()) {
      for (const entry of existing.tools ?? []) if (typeof entry !== "function") taken.set(entry.schema.name, existing.id);
      for (const id of Object.keys(existing.profiles ?? {})) profiles.add(id);
    }
    for (const entry of extension.tools ?? []) {
      if (typeof entry === "function") continue;
      const owner = taken.get(entry.schema.name);
      if (owner) throw new Error(`Tool ${entry.schema.name} from ${extension.id} is already registered by ${owner}.`);
      taken.set(entry.schema.name, extension.id);
    }
    for (const id of Object.keys(extension.profiles ?? {})) {
      if (profiles.has(id)) throw new Error(`Tool profile ${id} from ${extension.id} is already registered.`);
    }
    this.extensions.set(extension.id, extension);
    return () => {
      if (this.extensions.get(extension.id) === extension) this.extensions.delete(extension.id);
    };
  }

  /**
   * Capture a turn's contributions. Call it before the turn's first await, so
   * a turn never mixes old and new state. Throws on a duplicate tool name, an
   * unknown profile, or a profile naming a tool this turn does not have.
   */
  snapshot(context: TurnContext, profileId?: string): TurnContributions {
    // One object per turn. A factory that keys state by the context must see
    // the same object later in hooks; passing the caller's object to factories
    // and a copy as `turn.context` would split that identity.
    const turnContext: TurnContext = Object.freeze({ ...context });
    const extensions = [...this.extensions.values()];
    const all = new Map<string, ToolDefinition>();
    const owners = new Map<string, string>();
    for (const extension of extensions) {
      for (const entry of extension.tools ?? []) {
        const produced = typeof entry === "function" ? entry(turnContext) : entry;
        const list: readonly ToolDefinition[] = produced == null ? [] : "schema" in produced ? [produced] : produced;
        for (const definition of list) {
          const name = definition.schema.name;
          const owner = owners.get(name);
          if (owner) throw new Error(`Tool ${name} from ${extension.id} is already registered by ${owner}.`);
          owners.set(name, extension.id);
          all.set(name, Object.freeze({ ...definition }));
        }
      }
    }
    let tools = all;
    if (profileId !== undefined) {
      const names = extensions.find((extension) => extension.profiles && Object.hasOwn(extension.profiles, profileId))?.profiles?.[profileId];
      if (!names) throw new Error(`Unknown tool profile: ${profileId}.`);
      tools = new Map();
      for (const entry of names) {
        // A trailing `?` names a tool a factory may leave out of this turn (web search without a key).
        const optional = entry.endsWith("?");
        const name = optional ? entry.slice(0, -1) : entry;
        const definition = all.get(name);
        if (!definition) {
          if (optional) continue;
          throw new Error(`Tool profile ${profileId} names ${name}, which this turn does not have.`);
        }
        tools.set(name, definition);
      }
    }
    const stable: string[] = [];
    const volatile: string[] = [];
    for (const extension of extensions) {
      for (const section of extension.prompt ?? []) {
        const text = typeof section.text === "function" ? section.text(turnContext) : section.text;
        if (text) (section.placement === "stable" ? stable : volatile).push(text);
      }
    }
    // A copy of each table, so a handler swapped on the extension object mid-turn is not seen.
    const tables = extensions.filter((extension) => extension.hooks).map((extension) => ({ extensionId: extension.id, hooks: { ...extension.hooks } satisfies HookTable }));
    const runHook = async <E extends HookName>(hook: E, payload: HookEvents[E]): Promise<HookFailure[]> => {
      const failures: HookFailure[] = [];
      // In registration order, one at a time, so handlers see events in the order the turn made them.
      for (const { extensionId, hooks } of tables) {
        const handle: HookTable[E] = hooks[hook];
        if (!handle) continue;
        try { await handle(payload); }
        catch (error) { failures.push({ extensionId, hook, message: error instanceof Error ? error.message : String(error) }); }
      }
      return failures;
    };
    return Object.freeze({
      context: turnContext,
      tools,
      schemas: Object.freeze([...tools.values()].map((definition) => definition.schema)),
      guards: Object.freeze(extensions.flatMap((extension) => extension.guards ?? [])),
      prompt: Object.freeze({ stable: Object.freeze(stable), volatile: Object.freeze(volatile) }),
      runHook,
    });
  }
}
