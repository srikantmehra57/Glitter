import { SETTINGS_TABS, type SettingsTab } from "./types";

/**
 * Settings' information architecture: what each page is called, which group it
 * sits in, the line under its title, and the words a search finds it by. The
 * command palette and the Settings navigation both read these, so a page has
 * one name everywhere.
 */
export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  Models: "Models",
  Providers: "Providers",
  Agents: "Agents",
  Extensions: "Extensions",
  Permissions: "Permissions",
  Threads: "Threads",
  General: "General",
  Theme: "Appearance",
  Shortcuts: "Commands & shortcuts",
  Usage: "Usage",
  Diagnostics: "Diagnostics",
  About: "About",
};

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{ label: string; tabs: readonly SettingsTab[] }> = [
  { label: "AI", tabs: ["Models", "Providers", "Agents"] },
  { label: "Workspace", tabs: ["Extensions", "Permissions", "Threads"] },
  { label: "App", tabs: ["General", "Theme", "Shortcuts", "Usage"] },
  { label: "System", tabs: ["Diagnostics", "About"] },
];

export const SETTINGS_TAB_COPY: Record<SettingsTab, string> = {
  Models: "Defaults for new threads, and which models the picker offers. Test a model before you rely on it.",
  Providers: "Connect model providers with your own API keys. Keys stay in your Mac’s keychain.",
  Agents: "The built-in agent and the coding agent CLIs Glitter can run, with their sign-in and connection.",
  Extensions: "Skills, MCP servers and plugins, from the built-in store or your own.",
  Permissions: "How freely every agent works before it asks, and how tightly the Muse host is sandboxed.",
  Threads: "How far back the sidebar lists, and the threads you archived.",
  General: "Editor, notifications and suggestions.",
  Theme: "Theme, zoom, motion, font, dark intensity, accent colour, sidebar density and the thinking animation.",
  Shortcuts: "Your own slash commands, and every keyboard shortcut.",
  Usage: "Tokens and estimated cost across every agent and provider, counted on this Mac.",
  Diagnostics: "The health of this app and its agents, and what to share when something breaks.",
  About: "Version, updates and how Glitter handles your data.",
};

const SEARCH_TERMS: Record<SettingsTab, string> = {
  Models: "default model effort reasoning hide show enable disable visible test latency busy responsive picker",
  Providers: "api key byok bring your own anthropic claude openai gpt google gemini openrouter cline kilo xai grok deepseek groq mistral nvidia nim ollama lm studio local custom endpoint",
  Agents: "muse opencode grok gemini qwen goose cline third-party cli sign in out subscription api key credential binary path connection contributor harness built-in default agent agents.md",
  Extensions: "skills mcp servers plugins import store install",
  Permissions: "approval sandbox network shell file writes ephemeral read only ask auto full access",
  Threads: "archive restore delete history",
  General: "notifications alerts editor vscode cursor zed intellij suggestions",
  Theme: "light dark system intensity subtle mid pure black oled display interface zoom scale magnify enlarge shrink reduce motion accessibility animation font typeface helvetica avenir gill sans futura new york serif accent color colour sidebar density standard comfortable compact rows spacing tint translucent translucency transparency thinking orb animation",
  Shortcuts: "keybindings hotkeys remap custom commands slash macros prompts",
  Usage: "tokens cost spend",
  Diagnostics: "logs health enterprise protocol",
  About: "version update cli privacy data",
};

/** Pages whose name, description or search words contain every word of the query. */
export function settingsTabsMatching(query: string): SettingsTab[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...SETTINGS_TABS];
  return SETTINGS_TABS.filter((tab) => {
    const haystack = `${tab} ${SETTINGS_TAB_LABELS[tab]} ${SETTINGS_TAB_COPY[tab]} ${SEARCH_TERMS[tab]}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
