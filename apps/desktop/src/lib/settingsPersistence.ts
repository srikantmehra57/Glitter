import { normalizeCustomCommands } from "./composerText";
import { normalizeHiddenModels, normalizeHiddenProviders } from "./modelVisibility";
import { normalizeOrchestratorGoal, normalizeOrchestratorModels } from "./orchestrator";
import { normalizeHarnessRules } from "./permissionRules";
import { normalizeShortcutOverrides } from "./shortcuts";
import { normalizeUiFont } from "./fonts";
import { normalizeTranslucency } from "./theme";
import { DARK_INTENSITIES, DEFAULT_SETTINGS, EDITOR_CHOICES, SIDEBAR_DENSITIES, THINKING_ORBS, type Settings } from "./types";

type SettingsStore = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<unknown>;
  save(): Promise<unknown>;
};

/**
 * Settings that belonged to the Muse CLI and the third-party agents the app no
 * longer runs. A saved document may still hold them (an old plain-text
 * `museApiKey` among them), so they are dropped on load instead of being
 * carried forward with the other unknown keys.
 */
const RETIRED_SETTINGS = new Set(["museBin", "museApiKey", "museAuthMode", "contributorMode", "ephemeralSessions", "disableWrite", "disableShell", "sandboxNetwork", "defaultAgentId", "enabledAgents", "acpUnisolatedConsent", "hideAgentCapabilities", "suggestionsAgentId"]);

export function settingsFields(settings: Settings): Settings {
  const { theme, uiFont, darkIntensity, accentColor, accentSidebar, sidebarTranslucency, sidebarDensity, reduceMotion, thinkingOrb, defaultModel, defaultProviderId, defaultEffort, defaultApprovalMode, harnessRules, disableTerminal, notifications, editor, customCommands, suggestionsEnabled, suggestionsModelId, shortcutOverrides, orchestratorEnabled, orchestratorGoal, orchestratorModels, hiddenModels, hiddenProviders, workspaces } = settings;
  return { theme, uiFont: normalizeUiFont(uiFont), darkIntensity: DARK_INTENSITIES.find((level) => level === darkIntensity) ?? "mid", accentColor, accentSidebar, sidebarTranslucency: normalizeTranslucency(sidebarTranslucency), sidebarDensity: SIDEBAR_DENSITIES.find((density) => density === sidebarDensity) ?? "standard", reduceMotion: reduceMotion === true, thinkingOrb: THINKING_ORBS.find((style) => style === thinkingOrb) ?? "auto", defaultModel, defaultProviderId, defaultEffort, defaultApprovalMode, harnessRules: normalizeHarnessRules(harnessRules), disableTerminal: disableTerminal === true, notifications: notifications ?? true, editor: editor && EDITOR_CHOICES.includes(editor) ? editor : "default", customCommands: normalizeCustomCommands(customCommands), suggestionsEnabled: suggestionsEnabled === true, suggestionsModelId: typeof suggestionsModelId === "string" && suggestionsModelId.trim() ? suggestionsModelId.trim() : undefined, shortcutOverrides: normalizeShortcutOverrides(shortcutOverrides), orchestratorEnabled: orchestratorEnabled === true, orchestratorGoal: normalizeOrchestratorGoal(orchestratorGoal), orchestratorModels: normalizeOrchestratorModels(orchestratorModels), hiddenModels: normalizeHiddenModels(hiddenModels), hiddenProviders: normalizeHiddenProviders(hiddenProviders), workspaces };
}

export class SettingsPersistence {
  private unknownSettings: Record<string, unknown> = {};
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: SettingsStore, private preserveLegacyKey?: (key: string) => Promise<void>) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  load(): Promise<Settings> {
    return this.serialize(async () => {
      const saved = await this.store.get<Record<string, unknown>>("settings") ?? {};
      this.unknownSettings = Object.fromEntries(Object.entries(saved).filter(([key]) => !(key in DEFAULT_SETTINGS) && !RETIRED_SETTINGS.has(key)));
      const legacyKey = typeof saved.museApiKey === "string" ? saved.museApiKey.trim() : "";
      if (legacyKey && legacyKey !== "••••••••") {
        try {
          if (!this.preserveLegacyKey) throw new Error("The old key could not be moved to the system keychain.");
          await this.preserveLegacyKey(legacyKey);
        } catch (error) {
          // Even a later settings save must not remove the only copy after a
          // locked or unavailable keychain prevented migration.
          this.unknownSettings.museApiKey = saved.museApiKey;
          throw error;
        }
      }
      const disableTerminal = typeof saved.disableTerminal === "boolean" ? saved.disableTerminal : saved.disableShell === true;
      const settings = settingsFields({ ...DEFAULT_SETTINGS, ...(saved as Partial<Settings>), disableTerminal });
      // Rewrite once so retired keys, a plain-text key among them, leave the file.
      if (Object.keys(saved).some((key) => RETIRED_SETTINGS.has(key))) await this.writeSettings(settings);
      return settings;
    });
  }

  save(value: Settings): Promise<void> {
    const settings = settingsFields(value);
    return this.serialize(() => this.writeSettings(settings));
  }

  private async writeSettings(settings: Settings) {
    await this.store.set("settings", { ...this.unknownSettings, ...settings });
    await this.store.save();
  }
}
