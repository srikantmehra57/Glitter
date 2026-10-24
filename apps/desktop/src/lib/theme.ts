import { DEFAULT_SETTINGS, type AccentColor, type DarkIntensity, type Settings, type ThemeMode } from "./types";

/**
 * The theme engine: appearance settings in, what the document root should carry
 * out. Token values stay in styles.css; this only decides which token blocks
 * apply and sets the few values no selector can enumerate.
 */

/** The appearance settings the engine reads. */
export type ThemeSettings = Pick<Settings, "theme" | "darkIntensity" | "accentColor" | "accentSidebar" | "sidebarTranslucency">;

/** What the engine cannot know from settings alone. */
export type ThemeEnvironment = {
  /** The OS prefers dark. Decides the `system` theme. */
  prefersDark: boolean;
  /** The window has its own material behind the page, so the shell can be see-through. */
  windowMaterial: boolean;
  /** The OS asks for reduced transparency. */
  reducedTransparency: boolean;
};

export type ResolvedTheme = {
  /** `data-*` attributes for the document root. The token blocks in styles.css select on them. */
  attributes: { theme: "light" | "dark"; dark: DarkIntensity; accent: AccentColor; sidebarAccent: "true" | "false"; translucent: "true" | "false" };
  /** Custom properties for the document root. */
  properties: { "--shell-opacity": string };
  /** The appearance the native window takes, so its material matches the interface. */
  windowAppearance: ThemeMode;
};

/** The shell never fades out entirely: the tint and the sidebar's text keep something to sit on. */
const SHELL_OPACITY_FLOOR = 12;

/** A saved translucency as a whole percentage, 0 (solid) to 100; anything unusable takes the default. */
export function normalizeTranslucency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS.sidebarTranslucency;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** How opaque the shell is, as a percentage, for a translucency setting. */
export function shellOpacity(translucency: number): number {
  return Math.round(100 - (normalizeTranslucency(translucency) * (100 - SHELL_OPACITY_FLOOR)) / 100);
}

export function resolveTheme(settings: ThemeSettings, environment: ThemeEnvironment): ResolvedTheme {
  const dark = settings.theme === "dark" || (settings.theme === "system" && environment.prefersDark);
  // Without a material behind the page there is nothing to show through, and
  // reduced transparency asks for solid surfaces: both keep the shell opaque.
  const opacity = environment.windowMaterial && !environment.reducedTransparency ? shellOpacity(settings.sidebarTranslucency) : 100;
  return {
    attributes: {
      theme: dark ? "dark" : "light",
      // The dark-intensity token blocks select on data-theme="dark" too, so a
      // light interface never sees them even though the attribute is always set.
      dark: settings.darkIntensity,
      accent: settings.accentColor,
      sidebarAccent: settings.accentSidebar ? "true" : "false",
      translucent: opacity < 100 ? "true" : "false",
    },
    properties: { "--shell-opacity": String(opacity / 100) },
    windowAppearance: settings.theme,
  };
}
