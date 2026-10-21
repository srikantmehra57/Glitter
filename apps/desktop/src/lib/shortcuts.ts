/**
 * Every keyboard shortcut the app answers to, in one list. Settings → Shortcuts
 * (also the sheet behind the shortcut key) renders it, the key handler and the
 * native menu take their bindings from it, and the user's overrides are checked
 * against it. A binding added anywhere else is invisible to all three.
 */
export type ShortcutGroup = "General" | "Threads" | "Composer" | "Approvals";

/**
 * A chord: `mod` (⌘ on macOS, Ctrl elsewhere), optional `shift` and `alt`, then
 * a physical key as `KeyboardEvent.code`. Codes, because Shift and ⌥ change
 * what `key` reports on many layouts.
 */
export type Chord = string;

export const REMAPPABLE = {
  palette: { group: "General", label: "Command palette", chord: "mod+KeyK", menu: "command-palette" },
  settings: { group: "General", label: "Settings", chord: "mod+Comma", menu: "settings" },
  shortcuts: { group: "General", label: "Keyboard shortcuts", chord: "mod+Slash", menu: "shortcuts" },
  "open-workspace": { group: "General", label: "Open workspace", chord: "mod+KeyP", menu: "open-workspace" },
  "toggle-sidebar": { group: "General", label: "Toggle sidebar", chord: "mod+KeyB", menu: "toggle-sidebar" },
  "toggle-changes": { group: "General", label: "Toggle changes", chord: "mod+KeyI", menu: "toggle-changes" },
  terminal: { group: "General", label: "Toggle terminal", chord: "mod+KeyJ" },
  "zoom-in": { group: "General", label: "Zoom in", chord: "mod+Equal", menu: "zoom-in" },
  "zoom-out": { group: "General", label: "Zoom out", chord: "mod+Minus", menu: "zoom-out" },
  "zoom-reset": { group: "General", label: "Actual size", chord: "mod+Digit0", menu: "zoom-reset" },
  "new-thread": { group: "Threads", label: "New thread", chord: "mod+KeyN", menu: "new-thread" },
  find: { group: "Threads", label: "Find in thread", chord: "mod+KeyF", menu: "find-in-thread" },
  "search-threads": { group: "Threads", label: "Search threads", chord: "mod+shift+KeyF", menu: "search-threads" },
  "next-thread": { group: "Threads", label: "Next thread", chord: "mod+shift+BracketRight", menu: "next-thread" },
  "previous-thread": { group: "Threads", label: "Previous thread", chord: "mod+shift+BracketLeft", menu: "previous-thread" },
  attention: { group: "Threads", label: "Next thread needing attention", chord: "mod+alt+KeyA" },
  archive: { group: "Threads", label: "Archive thread", chord: "mod+shift+KeyA" },
  model: { group: "Composer", label: "Switch model", chord: "mod+shift+KeyI" },
  effort: { group: "Composer", label: "Reasoning effort", chord: "mod+shift+KeyE" },
  permissions: { group: "Composer", label: "Permissions", chord: "mod+shift+KeyM" },
} as const satisfies Record<string, { group: ShortcutGroup; label: string; chord: Chord; menu?: string }>;

export type ShortcutId = keyof typeof REMAPPABLE;
export const SHORTCUT_IDS = Object.keys(REMAPPABLE) as ShortcutId[];
export type ShortcutOverrides = Partial<Record<ShortcutId, Chord>>;

/** Shortcuts with a fixed meaning: text entry, approvals, and chords the OS or the webview owns. */
export const FIXED_SHORTCUTS: Array<{ group: ShortcutGroup; label: string; keys: string; plain?: boolean }> = [
  { group: "Threads", label: "Next / previous match", keys: "G / ⇧G" },
  { group: "Threads", label: "Go to thread 1–9", keys: "1–9" },
  { group: "Threads", label: "Next / previous thread", keys: "Ctrl+Tab / Ctrl+⇧Tab", plain: true },
  { group: "Composer", label: "Send", keys: "Enter", plain: true },
  { group: "Composer", label: "Newline", keys: "⇧Enter", plain: true },
  { group: "Composer", label: "Previous / next prompt", keys: "↑ / ↓", plain: true },
  { group: "Composer", label: "Stop the running turn", keys: "Esc", plain: true },
  { group: "Approvals", label: "Approve first choice", keys: "Y" },
  { group: "Approvals", label: "Approve wider scope", keys: "⇧Y" },
  { group: "Approvals", label: "Deny approval", keys: "⌫" },
  { group: "Approvals", label: "Approve / deny the focused approval", keys: "Enter / Esc", plain: true },
];

/** Chords that keep their meaning: editing, quitting, the fixed shortcuts above. */
const RESERVED = new Set([
  ...["KeyC", "KeyV", "KeyX", "KeyA", "KeyZ", "KeyQ", "KeyW", "KeyH", "KeyM", "KeyY", "KeyG", "Backspace", "Tab", "Enter"].map((code) => `mod+${code}`),
  "mod+shift+KeyZ", "mod+shift+KeyY", "mod+shift+KeyG", "mod+shift+Tab",
  ...Array.from({ length: 9 }, (_, index) => `mod+Digit${index + 1}`),
]);

/** Keys a chord may end in, with how each is shown and what the native menu calls it. */
const KEYS: Record<string, { label: string; accelerator: string }> = {
  ...Object.fromEntries(Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (letter) => [`Key${letter}`, { label: letter, accelerator: letter }])),
  ...Object.fromEntries(Array.from("0123456789", (digit) => [`Digit${digit}`, { label: digit, accelerator: digit }])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, { label: `F${index + 1}`, accelerator: `F${index + 1}` }])),
  Comma: { label: ",", accelerator: "," }, Period: { label: ".", accelerator: "." }, Slash: { label: "/", accelerator: "/" },
  Semicolon: { label: ";", accelerator: ";" }, Quote: { label: "'", accelerator: "'" }, Backslash: { label: "\\", accelerator: "\\" },
  BracketLeft: { label: "[", accelerator: "[" }, BracketRight: { label: "]", accelerator: "]" },
  Equal: { label: "+", accelerator: "=" }, Minus: { label: "−", accelerator: "-" }, Backquote: { label: "`", accelerator: "`" },
  Backspace: { label: "⌫", accelerator: "Backspace" }, Tab: { label: "Tab", accelerator: "Tab" }, Enter: { label: "↵", accelerator: "Enter" },
};

const parse = (chord: Chord) => {
  const parts = chord.split("+");
  const code = parts[parts.length - 1];
  return { shift: parts.includes("shift"), alt: parts.includes("alt"), code, key: KEYS[code] };
};

/** The chord a key event makes, or null when it is not one (no ⌘/Ctrl, a bare modifier, AltGr text entry). */
export function chordOf(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string; getModifierState?: (key: string) => boolean }): Chord | null {
  // AltGr reports Ctrl+Alt on many layouts and types letters; it stays with the text field.
  if (!(event.metaKey || event.ctrlKey) || event.getModifierState?.("AltGraph") || !KEYS[event.code]) return null;
  return `mod${event.shiftKey ? "+shift" : ""}${event.altKey ? "+alt" : ""}+${event.code}`;
}

export const isChord = (value: unknown): value is Chord => typeof value === "string" && /^mod(\+shift)?(\+alt)?\+[A-Za-z0-9]+$/.test(value) && Boolean(parse(value).key);

/**
 * Saved overrides, keeping only known actions bound to usable, unreserved,
 * distinct chords. Checked as a whole set, so a saved swap of two shortcuts
 * survives; an entry that still collides falls back to its default.
 */
export function normalizeShortcutOverrides(value: unknown): ShortcutOverrides {
  const out: ShortcutOverrides = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const id of SHORTCUT_IDS) {
    const chord = (value as Record<string, unknown>)[id];
    if (isChord(chord) && chord !== REMAPPABLE[id].chord && !RESERVED.has(chord)) out[id] = chord;
  }
  // Dropping one entry restores a default, which can collide in turn; repeat until settled.
  for (let pass = 0; pass < SHORTCUT_IDS.length; pass += 1) {
    const clash = SHORTCUT_IDS.find((id) => out[id] && SHORTCUT_IDS.some((other) => other !== id && bindingFor(other, out) === out[id]));
    if (!clash) break;
    delete out[clash];
  }
  return out;
}

export const bindingFor = (id: ShortcutId, overrides: ShortcutOverrides = {}): Chord => overrides[id] ?? REMAPPABLE[id].chord;

/** The action a chord runs under these overrides. */
export function actionFor(chord: Chord, overrides: ShortcutOverrides = {}): ShortcutId | undefined {
  return SHORTCUT_IDS.find((id) => bindingFor(id, overrides) === chord);
}

/** Why `chord` cannot be bound to `id`, or null when it can. */
export function bindingProblem(id: ShortcutId, chord: Chord, overrides: ShortcutOverrides = {}): string | null {
  if (!isChord(chord)) return "Use ⌘ or Ctrl with a letter, digit, function key or punctuation key.";
  if (RESERVED.has(chord)) return "That shortcut is reserved for editing, approvals or thread switching.";
  const taken = SHORTCUT_IDS.find((other) => other !== id && bindingFor(other, overrides) === chord);
  return taken ? `That shortcut is already used by ${REMAPPABLE[taken].label}.` : null;
}

/** "⌘⇧F" on macOS, "Ctrl+Shift+F" elsewhere. */
export function chordLabel(chord: Chord, mac: boolean): string {
  const { shift, alt, key, code } = parse(chord);
  const name = key?.label ?? code;
  return mac ? `⌘${alt ? "⌥" : ""}${shift ? "⇧" : ""}${name}` : ["Ctrl", ...(alt ? ["Alt"] : []), ...(shift ? ["Shift"] : []), name].join("+");
}

/** The native menu's spelling of a chord. */
export function chordAccelerator(chord: Chord): string {
  const { shift, alt, key, code } = parse(chord);
  return ["CmdOrCtrl", ...(shift ? ["Shift"] : []), ...(alt ? ["Alt"] : []), key?.accelerator ?? code].join("+");
}

/** Native menu item id → accelerator, for every overridden shortcut that has a menu item. */
export function menuAccelerators(overrides: ShortcutOverrides): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of SHORTCUT_IDS) {
    const menu = menuOf(id);
    const chord = overrides[id];
    if (menu && chord) out[menu] = chordAccelerator(chord);
  }
  return out;
}

const menuOf = (id: ShortcutId): string | undefined => {
  const entry = REMAPPABLE[id];
  return "menu" in entry ? entry.menu : undefined;
};
/** Whether the native menu owns this action's key in the desktop shell. */
export const menuOwned = (id: ShortcutId): boolean => menuOf(id) !== undefined;
export const shortcutForMenu = (menu: string): ShortcutId | undefined => SHORTCUT_IDS.find((id) => menuOf(id) === menu);
