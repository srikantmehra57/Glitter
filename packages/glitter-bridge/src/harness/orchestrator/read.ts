/** The only tools a read-only stage (scout or Lead reads) may use. */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["read_file", "list_files", "grep"]);
