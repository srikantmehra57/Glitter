export type FileNode = { name: string; path: string; children?: FileNode[] };

/**
 * A directory tree from workspace-relative file paths: folders first, then
 * files, each level by name. A folder's `path` ends without a slash and is
 * unique, so it doubles as the key for what is expanded.
 */
export function buildFileTree(paths: string[]): FileNode[] {
  const root: FileNode = { name: "", path: "", children: [] };
  const folders = new Map<string, FileNode>([["", root]]);
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let parent = root;
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const key = parts.slice(0, depth + 1).join("/");
      let folder = folders.get(key);
      if (!folder) {
        folder = { name: parts[depth], path: key, children: [] };
        folders.set(key, folder);
        parent.children!.push(folder);
      }
      parent = folder;
    }
    parent.children!.push({ name: parts[parts.length - 1], path });
  }
  const sort = (nodes: FileNode[]) => {
    nodes.sort((a, b) => Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.name.localeCompare(b.name));
    for (const node of nodes) if (node.children) sort(node.children);
  };
  sort(root.children!);
  return root.children!;
}

const indexed = new WeakMap<readonly string[], Set<string>>();

/**
 * The workspace file a piece of inline code names, or null. Only a path that
 * is in the file index counts, so ordinary code like `a/b` or `user.name` is
 * never turned into a link. A trailing `:line` or `:line:column` is ignored.
 */
export function indexedPath(text: string, paths: readonly string[] | undefined, toRelative: (raw: string) => string | null): string | null {
  const raw = text.trim().replace(/:\d+(?::\d+)?$/, "");
  if (!paths?.length || !raw || raw.length > 300 || /\s/.test(raw)) return null;
  let known = indexed.get(paths);
  if (!known) { known = new Set(paths); indexed.set(paths, known); }
  const relative = toRelative(raw);
  return relative && known.has(relative) ? relative : null;
}

/** One-letter badge for a porcelain XY status, as the Changes list reads it. */
export function statusBadge(status: string): string {
  if (status === "??") return "U";
  const letter = status.trim()[0] ?? "";
  return letter === "R" || letter === "C" ? "R" : letter;
}

/** Human size for the viewer's header. */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / (1024 * 102.4)) / 10} MB`;
}
