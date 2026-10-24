import { UI_FONTS, type UiFont } from "./types";

/**
 * Installed faces for the interface. Nothing is downloaded: each stack starts
 * with a face that ships on macOS and falls through to a relative that ships
 * more widely. The System stack is also the `--font-sans` declaration in
 * styles.css, so the first paint matches the default before settings load.
 */
export const UI_FONT_STACKS: Record<UiFont, string> = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", system-ui, sans-serif',
  helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  avenir: '"Avenir Next", Avenir, "Century Gothic", sans-serif',
  gill: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif',
  futura: 'Futura, "Trebuchet MS", sans-serif',
  newYork: '"New York Small", "New York Medium", "New York", "Iowan Old Style", Palatino, Georgia, serif',
};

export const UI_FONT_COPY: Record<UiFont, { label: string; description: string }> = {
  system: { label: "System", description: "SF Pro on this Mac." },
  helvetica: { label: "Helvetica", description: "Helvetica Neue." },
  avenir: { label: "Avenir", description: "Avenir Next." },
  gill: { label: "Gill Sans", description: "A humanist face." },
  futura: { label: "Futura", description: "A geometric face." },
  newYork: { label: "New York", description: "A text serif." },
};

/** A saved face, or System when the value is missing or not one of the choices. */
export function normalizeUiFont(value: unknown): UiFont {
  return UI_FONTS.find((font) => font === value) ?? "system";
}

/** The `--font-sans` stack for a saved face. */
export function uiFontStack(value: unknown): string {
  return UI_FONT_STACKS[normalizeUiFont(value)];
}
