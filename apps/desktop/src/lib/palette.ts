export type PaletteSection = "Recent" | "Actions" | "Threads" | "Files" | "Settings";

export type PaletteItem = {
  id: string;
  label: string;
  section: Exclude<PaletteSection, "Recent">;
  /** Extra words the filter accepts besides the label. */
  keywords?: string;
  /** Set by the caller when matching is not plain text (thread contents, fuzzy file paths). */
  matched?: boolean;
};

const ORDER: Array<Exclude<PaletteSection, "Recent">> = ["Actions", "Threads", "Files", "Settings"];
export const RECENT_COMMANDS_MAX = 5;

/**
 * Rows in display order with the section each one sits under. With no query
 * the commands used most recently lead under "Recent" and files stay out
 * (there are thousands); a query filters every section and drops the Recent
 * grouping so results keep one predictable order.
 */
export function paletteRows<T extends PaletteItem>(items: T[], query: string, recent: string[] = []): Array<{ item: T; section: PaletteSection }> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (item: T) => {
    if (item.matched != null) return item.matched;
    const hay = `${item.label} ${item.keywords ?? ""}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  };
  const visible = items.filter((item) => (terms.length ? matches(item) : item.section !== "Files"));
  const rows: Array<{ item: T; section: PaletteSection }> = [];
  const used = new Set<string>();
  if (!terms.length) {
    for (const id of recent.slice(0, RECENT_COMMANDS_MAX)) {
      const item = visible.find((entry) => entry.id === id);
      if (item && !used.has(id)) { used.add(id); rows.push({ item, section: "Recent" }); }
    }
  }
  for (const section of ORDER) {
    for (const item of visible) if (item.section === section && !used.has(item.id)) rows.push({ item, section });
  }
  return rows;
}

/** Most recent first, each id once, capped. */
export function rememberCommand(recent: string[], id: string): string[] {
  return [id, ...recent.filter((entry) => entry !== id)].slice(0, RECENT_COMMANDS_MAX);
}
