import { normalizeCustomCommands } from "./composerText";
import { normalizeHiddenModels, normalizeHiddenProviders } from "./modelVisibility";
import { normalizeShortcutOverrides } from "./shortcuts";
import { normalizeTranslucency } from "./theme";
import { AGENT_IDS, DEFAULT_ENABLED_AGENTS, DEFAULT_SETTINGS, EDITOR_CHOICES, THINKING_ORBS, type Settings } from "./types";

type SettingsStore = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<unknown>;
  save(): Promise<unknown>;
};
type Credentials = { get(): Promise<string | null>; set(value: string): Promise<void> };
const SAVED_KEY_MASK = "••••••••";

export function settingsFields(settings: Settings): Settings {
  const { museBin, museApiKey, museAuthMode, contributorMode, ephemeralSessions, disableWrite, disableShell, sandboxNetwork, theme, accentColor, accentSidebar, sidebarTranslucency, thinkingOrb, defaultModel, defaultProviderId, defaultEffort, defaultApprovalMode, defaultAgentId, enabledAgents, acpUnisolatedConsent, hideAgentCapabilities, notifications, editor, customCommands, suggestionsEnabled, suggestionsAgentId, suggestionsModelId, shortcutOverrides, hiddenModels, hiddenProviders, workspaces } = settings;
  return { museBin, museApiKey, museAuthMode: museAuthMode ?? DEFAULT_SETTINGS.museAuthMode, contributorMode: contributorMode === "on" || contributorMode === "off" ? contributorMode : undefined, ephemeralSessions: ephemeralSessions ?? false, disableWrite: disableWrite ?? false, disableShell: disableShell ?? false, sandboxNetwork: sandboxNetwork ?? "proxy-only", theme, accentColor, accentSidebar, sidebarTranslucency: normalizeTranslucency(sidebarTranslucency), thinkingOrb: THINKING_ORBS.find((style) => style === thinkingOrb) ?? "auto", defaultModel, defaultProviderId, defaultEffort, defaultApprovalMode, defaultAgentId, enabledAgents: { ...DEFAULT_ENABLED_AGENTS, ...enabledAgents }, acpUnisolatedConsent: acpUnisolatedConsent === true, hideAgentCapabilities: hideAgentCapabilities === true, notifications: notifications ?? true, editor: editor && EDITOR_CHOICES.includes(editor) ? editor : "default", customCommands: normalizeCustomCommands(customCommands), suggestionsEnabled: suggestionsEnabled === true, suggestionsAgentId: suggestionsAgentId && AGENT_IDS.includes(suggestionsAgentId) ? suggestionsAgentId : undefined, suggestionsModelId: typeof suggestionsModelId === "string" && suggestionsModelId.trim() ? suggestionsModelId.trim() : undefined, shortcutOverrides: normalizeShortcutOverrides(shortcutOverrides), hiddenModels: normalizeHiddenModels(hiddenModels), hiddenProviders: normalizeHiddenProviders(hiddenProviders), workspaces };
}

export class SettingsPersistence {
  private key: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: SettingsStore, private credentials: Credentials) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  load(): Promise<Settings> {
    return this.serialize(async () => {
      const saved = await this.store.get<Partial<Settings>>("settings") ?? {};
      const secureKey = await this.credentials.get();
      const legacyKey = saved.museApiKey?.trim() ?? "";
      // Never delete the only persisted copy if the credential store is locked.
      if (secureKey === null && legacyKey) await this.credentials.set(legacyKey);
      this.key = secureKey ?? legacyKey;
      const settings = settingsFields({ ...DEFAULT_SETTINGS, ...saved, museApiKey: this.key });
      if (Object.prototype.hasOwnProperty.call(saved, "museApiKey")) {
        await this.writePublicSettings(settings);
      }
      return settings;
    });
  }

  save(value: Settings): Promise<void> {
    const settings = settingsFields(value);
    return this.serialize(async () => {
      const previousKey = this.key ?? await this.credentials.get() ?? "";
      const changed = previousKey !== settings.museApiKey;
      // A masked value means "unchanged": native `credential_get` returns only
      // the mask (never the real key), so preserve the previous value instead
      // of storing the mask itself.
      const effectiveKey = settings.museApiKey === SAVED_KEY_MASK ? previousKey : settings.museApiKey;
      // Public settings exclude the key, so they go first: a failure leaves the
      // credential untouched. Writing the credential first would need a rollback
      // on failure — and the rollback would write the mask over the real key.
      await this.writePublicSettings(settings);
      if (changed) await this.credentials.set(effectiveKey);
      this.key = effectiveKey;
    });
  }

  private async writePublicSettings(settings: Settings) {
    const { museApiKey: _secret, ...publicSettings } = settings;
    await this.store.set("settings", publicSettings);
    await this.store.save();
  }
}
