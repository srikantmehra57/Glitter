/**
 * Terminal output for `glitter`. Model and tool text is untrusted: every
 * string passes `safeText`, which removes escape sequences and control
 * characters, so a reply cannot move the cursor, retitle the window or hide
 * text from the user.
 */

type Json = Record<string, unknown>;
type Out = { write(text: string): unknown };

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const wrap = (open: string, close: string) => (text: string) => (COLOR ? `\u001b[${open}m${text}\u001b[${close}m` : text);

export const paint = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  red: wrap("31", "39"),
  yellow: wrap("33", "39"),
  green: wrap("32", "39"),
  accent: wrap("35", "39"),
};

// CSI/OSC/other escape sequences, then any remaining C0 (except tab and newline), DEL and C1 controls.
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function safeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(ESCAPES, "").replace(CONTROLS, "");
}

/** The one-line description of a tool call: its command, its path, or nothing. */
export function toolSummary(item: Json): string {
  if (typeof item.commandText === "string") return `$ ${item.commandText}`;
  let args: Json = {};
  try { args = JSON.parse(typeof item.args === "string" ? item.args : "{}") as Json; } catch { return ""; }
  for (const key of ["path", "pattern", "url", "query", "name", "description"]) {
    if (typeof args[key] === "string" && args[key]) return String(args[key]);
  }
  return "";
}

export class Renderer {
  /** Streamed text per item, so a completed item prints only what deltas missed. */
  private printed = new Map<string, number>();
  private shown = new Set<string>();
  private kinds = new Map<string, string>();
  private midLine = false;
  /** Echo the user's own messages: on while a resumed thread replays its history. */
  replaying = false;

  /**
   * `text` receives the agent's reply; `info` receives steps and notices.
   * A headless text run sends the reply to stdout and steps to stderr.
   */
  constructor(private readonly text: Out | null, private readonly info: Out | null, private readonly options: { verbose: boolean }) {}

  private line(text: string) {
    if (!this.info) return;
    this.breakLine();
    this.info.write(`${text}\n`);
  }

  private breakLine() {
    if (this.midLine) {
      this.text?.write("\n");
      this.midLine = false;
    }
  }

  private stream(itemId: string, full: string, style: (text: string) => string = (text) => text, out = this.text) {
    if (!out) return;
    const done = this.printed.get(itemId) ?? 0;
    if (full.length <= done) return;
    const fresh = safeText(full.slice(done));
    this.printed.set(itemId, full.length);
    if (!fresh) return;
    out.write(style(fresh));
    this.midLine = !fresh.endsWith("\n");
  }

  item(item: Json) {
    const itemId = String(item.itemId ?? "");
    const text = typeof item.text === "string" ? item.text : "";
    if (typeof item.kind === "string") this.kinds.set(itemId, item.kind);
    switch (item.kind) {
      case "userMessage":
        if (this.replaying && text) this.line(`${paint.accent("›")} ${safeText(text)}`);
        return;
      case "agentMessage":
        if (!this.printed.has(itemId)) this.breakLine();
        this.stream(itemId, text);
        if (item.status !== "inProgress") this.breakLine();
        return;
      case "reasoning":
        if (this.options.verbose) {
          this.stream(itemId, text, paint.dim, this.info);
          if (item.status !== "inProgress") this.breakLine();
        } else if (!this.shown.has(itemId)) {
          this.shown.add(itemId);
          this.line(paint.dim("· Thinking…"));
        }
        return;
      case "toolCall":
        this.tool(itemId, item);
        return;
      case "compaction":
        if (item.status !== "inProgress") this.line(paint.dim("· Context compacted"));
        return;
      case "subagent":
        if (!this.shown.has(itemId)) {
          this.shown.add(itemId);
          this.line(paint.dim(`· Subagent: ${safeText(String(item.title ?? item.description ?? "working"))}`));
        }
        return;
    }
  }

  private tool(itemId: string, item: Json) {
    const name = safeText(String(item.tool ?? "tool"));
    const summary = safeText(toolSummary(item)).split("\n")[0].slice(0, 160);
    if (!this.shown.has(itemId)) {
      this.shown.add(itemId);
      this.line(`${paint.accent("●")} ${paint.bold(name)}${summary ? ` ${paint.dim(summary)}` : ""}`);
    }
    if (item.status === "inProgress") return;
    if (item.status === "failed") {
      const reason = safeText(String(item.failureReason ?? item.visibleOutput ?? "Failed.")).split("\n")[0].slice(0, 300);
      this.line(`  ${paint.red("⎿")} ${paint.red(reason)}`);
      return;
    }
    const output = safeText(typeof item.visibleOutput === "string" ? item.visibleOutput : "").trimEnd();
    if (!output) { this.line(`  ${paint.dim("⎿ done")}`); return; }
    const lines = output.split("\n");
    const limit = this.options.verbose ? lines.length : 3;
    for (const [at, text] of lines.slice(0, limit).entries()) this.line(`  ${paint.dim(at === 0 ? "⎿" : " ")} ${paint.dim(text.slice(0, 200))}`);
    if (lines.length > limit) this.line(`    ${paint.dim(`… ${lines.length - limit} more lines`)}`);
  }

  delta(itemId: string, delta: string) {
    const kind = this.kinds.get(itemId);
    const done = this.printed.get(itemId);
    if (done === undefined || (kind !== "agentMessage" && kind !== "reasoning")) return;
    if (kind === "reasoning" && !this.options.verbose) return;
    const out = kind === "reasoning" ? this.info : this.text;
    this.printed.set(itemId, done + delta.length);
    const fresh = safeText(delta);
    if (!out || !fresh) return;
    out.write(kind === "reasoning" ? paint.dim(fresh) : fresh);
    this.midLine = !fresh.endsWith("\n");
  }

  notice(message: string, warning = false) {
    if (!message) return;
    this.line(warning ? `${paint.yellow("!")} ${safeText(message)}` : paint.dim(`· ${safeText(message)}`));
  }

  route(route: Json | undefined) {
    if (!this.options.verbose || !route) return;
    const shape = typeof route.shape === "string" ? route.shape : "";
    if (shape) this.line(paint.dim(`· Orchestrator: ${safeText(shape)}`));
  }

  endTurn() {
    this.breakLine();
  }

  rule() {
    this.line(paint.dim("─".repeat(24)));
  }
}
