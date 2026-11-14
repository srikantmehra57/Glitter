import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { HarnessHost, type HarnessModel } from "./harness/host.js";
import { mcpConfigFingerprints } from "./harness/mcp-config.js";
import type { McpAuthorization } from "./harness/mcp.js";
import { configuredProviders } from "./harness/providers.js";
import { SessionStore } from "./harness/store.js";
import { diagnostics } from "./redaction.js";
import type { UserInputRequest, UserInputResponse } from "./protocol.js";
import { HELP, PERMISSIONS, UsageError, parseArgs, type CliArgs, type PermissionName } from "./cli/args.js";
import { appDefaults, harnessDataDir, loadCredentials } from "./cli/config.js";
import { Renderer, paint, safeText } from "./cli/render.js";

declare const __GLITTER_VERSION__: string;
const VERSION = typeof __GLITTER_VERSION__ === "string" ? __GLITTER_VERSION__ : "dev";

type Json = Record<string, unknown>;
type TurnEnd = { turnId: string; outcome: Json; text: string; questions: UserInputRequest[] };
type ApprovalEvent = { approvalId: string; sessionId: string; toolName: string; rawArgs?: string; subject?: { kind?: string; path?: string; risk?: string }; availableChoices?: Array<{ choiceId: string; label: string; scopeLabel?: string; decision?: string }> };

const PERMISSION_OF: Record<string, PermissionName> = Object.fromEntries(Object.entries(PERMISSIONS).map(([name, mode]) => [mode, name as PermissionName]));

/**
 * `glitter`: the Harness agent in a terminal. It runs the same engine as the
 * app in this process, reads the app's provider keys and writes the app's
 * thread store, so a thread can move between the two.
 */
async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`glitter: ${error.message}\nRun glitter --help for usage.\n`);
      return 2;
    }
    throw error;
  }
  if (args.command === "help") { process.stdout.write(`${HELP}\n`); return 0; }
  if (args.command === "version") { process.stdout.write(`glitter ${VERSION}\n`); return 0; }

  const workspaceRoot = workspaceOf(args.cwd);
  const credentials = loadCredentials({ keychain: args.keychain });
  const defaults = appDefaults();
  const dataDir = harnessDataDir();
  // A terminal has no trust prompt, so the folder is untrusted until a flag says
  // otherwise: its AGENTS.md, CLAUDE.md and skills stay out of the prompt, as in the app.
  // --trust alone leaves workspace MCP servers off, because no configuration digest is approved.
  let authorization: McpAuthorization = { workspaceTrusted: args.trust || args.mcp };
  if (args.mcp) {
    const fingerprints = await mcpConfigFingerprints(workspaceRoot, homedir());
    authorization = { workspaceTrusted: true, ...fingerprints };
  }

  // A headless text run prints the reply on stdout and its steps on stderr; JSON runs print only their JSON.
  const renderer = !args.print
    ? new Renderer(process.stdout, process.stdout, { verbose: args.verbose })
    : args.outputFormat === "text" ? new Renderer(process.stdout, process.stderr, { verbose: args.verbose }) : new Renderer(null, null, { verbose: false });
  const session = new Session(renderer, args);
  const host = new HarnessHost((event, payload) => session.event(event, payload as Json), new SessionStore(dataDir), fetch, {}, () => authorization);
  session.host = host;
  host.setCredentials(credentials);
  const ruleProblems = host.setPermissionRules(defaults.rules, defaults.protectedPaths).problems;
  if (ruleProblems.length && !args.print) renderer.notice(`Some saved permission rules were skipped: ${ruleProblems.join(" ")}`);

  try {
    // Reads the model library the app keeps beside the threads.
    await host.start();
    if (!configuredProviders(credentials).length) {
      process.stderr.write("glitter: no model provider is set up. Add an API key in Glitter → Settings → Models & providers, or set one such as ANTHROPIC_API_KEY.\n");
      return 1;
    }
    if (args.command === "models") return await listModels(host);
    if (args.command === "sessions") return await listSessions(host, workspaceRoot);

    const approvalMode = args.permission ? PERMISSIONS[args.permission] : defaults.approvalMode ?? "onRequest";
    const opened = await session.open({ workspaceRoot, approvalMode, modelId: args.model ?? (args.resume || args.continueLast ? undefined : defaults.modelId), effort: args.effort ?? defaults.effort });
    if (!opened) return 1;
    if (args.print) return await headless(session, args);
    return await interactive(session, args, workspaceRoot);
  } finally {
    await host.stop().catch(() => {});
  }
}

function workspaceOf(cwd: string | undefined): string {
  const path = resolve(cwd ?? process.cwd());
  let real: string;
  try {
    real = realpathSync(path);
    if (!statSync(real).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new UsageError(`${path} is not a folder.`);
  }
  if (real === "/" || real === realpathSync(homedir())) {
    process.stderr.write(`glitter: working in ${real} gives the agent your whole ${real === "/" ? "disk" : "home folder"}. Run it inside a project folder instead.\n`);
    process.exit(2);
  }
  return real;
}

async function listModels(host: HarnessHost): Promise<number> {
  const { models } = await host.listModels(undefined, true);
  if (!models.length) { process.stdout.write("No models are available from your providers.\n"); return 1; }
  for (const model of models) process.stdout.write(`${model.isDefault ? "*" : " "} ${model.modelId}${model.displayLabel ? `  ${paint.dim(safeText(model.displayLabel))}` : ""}\n`);
  return 0;
}

async function listSessions(host: HarnessHost, workspaceRoot: string): Promise<number> {
  const { sessions } = await host.listSessions(workspaceRoot);
  if (!sessions.length) { process.stdout.write("No threads in this folder yet.\n"); return 0; }
  for (const row of sessions) process.stdout.write(`${row.sessionId}  ${paint.dim(row.updatedAt.slice(0, 16).replace("T", " "))}  ${safeText(row.name ?? "Untitled")}\n`);
  return 0;
}

/** One open thread: sends turns and turns the Harness's events into output and prompts. */
class Session {
  host!: HarnessHost;
  sessionId = "";
  modelId = "";
  mode = "build";
  approvalMode = "onRequest";
  private waiting: { turnId: string | null; resolve: (end: TurnEnd) => void } | null = null;
  private questions: UserInputRequest[] = [];
  private turnText = "";
  /** Answers approvals in a chat; headless runs deny them. */
  approve: (approval: ApprovalEvent) => Promise<string> = async () => "deny";

  constructor(private readonly renderer: Renderer, private readonly args: CliArgs) {}

  /** A question the thread was already waiting on when it was resumed. */
  pending: UserInputRequest[] = [];
  /** Drops events while a resumed thread replays its history in a headless run. */
  private muted = false;

  async open(options: { workspaceRoot: string; approvalMode: string; modelId?: string; effort?: string }): Promise<boolean> {
    this.approvalMode = options.approvalMode;
    let sessionId = this.args.resume;
    if (this.args.continueLast) {
      sessionId = (await this.host.listSessions(options.workspaceRoot)).sessions[0]?.sessionId;
      if (!sessionId) { process.stderr.write("glitter: this folder has no thread to continue.\n"); return false; }
    }
    if (sessionId) {
      const meta = (await this.host.listSessions()).sessions.find((row) => row.sessionId === sessionId);
      if (!meta) { process.stderr.write(`glitter: no thread ${sessionId}. Run glitter sessions to list them.\n`); return false; }
      // Set first: the thread's history replays as item events while it opens.
      this.sessionId = sessionId;
      this.muted = this.args.print;
      this.renderer.replaying = true;
      let resumed: Json;
      try {
        resumed = await this.host.resumeSession({ sessionId, workspaceRoot: meta.workspaceRoot, approvalMode: options.approvalMode }) as Json;
      } finally {
        this.muted = false;
        this.renderer.replaying = false;
      }
      this.adopt(resumed);
      this.pending = Array.isArray(resumed.userInputs) ? resumed.userInputs as UserInputRequest[] : [];
      if (this.args.model) await this.host.setModel({ sessionId, modelId: this.args.model });
      if (this.args.mode) await this.host.setOption(sessionId, "mode", this.args.mode);
      if (this.args.effort) await this.host.setOption(sessionId, "effort", this.args.effort);
      if (!this.args.print) this.renderer.rule();
      return true;
    }
    const started = await this.host.startSession({
      workspaceRoot: options.workspaceRoot,
      modelId: options.modelId,
      effort: options.effort,
      mode: this.args.mode,
      approvalMode: options.approvalMode,
    }) as Json;
    this.sessionId = String(started.sessionId);
    this.adopt(started);
    return true;
  }

  private adopt(result: Json) {
    const config = (result.config ?? result.agentConfig ?? {}) as Json;
    if (typeof config.modelId === "string") this.modelId = config.modelId;
    if (typeof config.mode === "string") this.mode = config.mode;
  }

  get permission(): string { return PERMISSION_OF[this.approvalMode] ?? this.approvalMode; }

  /** Send a prompt and wait for its turn, and any turn its answers start, to end. */
  async run(text: string): Promise<TurnEnd> {
    this.questions = [];
    this.turnText = "";
    const ended = this.nextEnd(null);
    try {
      const sent = await this.host.sendTurn({ sessionId: this.sessionId, text }) as Json;
      if (this.waiting && typeof sent.turnId === "string") this.waiting.turnId = sent.turnId;
    } catch (error) {
      this.waiting = null;
      throw error;
    }
    return ended;
  }

  /** Continue after the user answered the question a turn ended with. */
  async answer(request: UserInputRequest, response: UserInputResponse): Promise<TurnEnd | null> {
    this.questions = [];
    this.turnText = "";
    const ended = this.nextEnd(null);
    const result = await this.host.respondUserInput({ sessionId: this.sessionId, userInputId: request.userInputId, response }) as Json;
    if (typeof result.turnId !== "string") { this.waiting = null; return null; }
    if (this.waiting) this.waiting.turnId = result.turnId;
    return ended;
  }

  private nextEnd(turnId: string | null): Promise<TurnEnd> {
    return new Promise((resolveEnd) => { this.waiting = { turnId, resolve: resolveEnd }; });
  }

  async cancel() {
    await this.host.cancelTurn({ sessionId: this.sessionId }).catch(() => {});
  }

  get busy() { return this.waiting !== null; }

  event(event: string, payload: Json) {
    if (this.muted || (payload.sessionId !== undefined && payload.sessionId !== this.sessionId)) return;
    if (this.args.print && this.args.outputFormat === "stream-json") process.stdout.write(`${JSON.stringify({ type: event, ...diagnosticSafe(payload) })}\n`);
    switch (event) {
      case "item": {
        const item = payload.item as Json;
        if (item.kind === "agentMessage" && item.status === "completed" && typeof item.text === "string") this.turnText = this.turnText ? `${this.turnText}\n\n${item.text}` : item.text;
        this.renderer.item(item);
        break;
      }
      case "delta":
        this.renderer.delta(String(payload.itemId ?? ""), String(payload.delta ?? ""));
        break;
      case "agentNotice":
        this.renderer.notice(String(payload.message ?? ""), payload.level === "warning");
        break;
      case "route":
        this.renderer.route(payload.route as Json);
        break;
      case "agentConfig":
        this.adopt({ config: payload.config });
        break;
      case "approval":
        // `decide` already denies when asking fails; the failure itself has nowhere to go.
        void this.decide(payload as unknown as ApprovalEvent).catch(() => undefined);
        break;
      case "userInputs": {
        const requests = Array.isArray(payload.requests) ? payload.requests as UserInputRequest[] : [];
        this.questions = requests;
        break;
      }
      case "turnCompleted": {
        const waiting = this.waiting;
        if (!waiting || (waiting.turnId && waiting.turnId !== payload.turnId)) break;
        this.renderer.endTurn();
        // The question a turn ends with arrives just after it; read it on the next tick.
        setImmediate(() => {
          this.waiting = null;
          waiting.resolve({ turnId: String(payload.turnId), outcome: (payload.outcome ?? {}) as Json, text: this.turnText, questions: this.questions });
        });
        break;
      }
    }
  }

  private async decide(approval: ApprovalEvent) {
    let choiceId = "deny";
    try {
      choiceId = await this.approve(approval);
    } finally {
      try { this.host.decideApproval({ approvalId: approval.approvalId, choiceId }); } catch { /* expired or already settled */ }
    }
  }
}

function diagnosticSafe(payload: Json): Json {
  return JSON.parse(diagnostics.text(JSON.stringify(payload))) as Json;
}

/** Outcome of a turn: `completed`, `cancelled` or `failed`, and the error when it failed. */
function outcomeOf(end: TurnEnd): { terminal: string; error?: { message: string; code?: string } } {
  const params = (end.outcome.params ?? {}) as Json;
  const terminal = typeof params.terminal === "string" ? params.terminal : String(end.outcome.kind ?? "completed");
  const error = params.error as { message?: unknown; code?: unknown } | undefined;
  return { terminal, ...(error ? { error: { message: diagnostics.text(String(error.message ?? "The turn failed.")), ...(typeof error.code === "string" ? { code: error.code } : {}) } } : {}) };
}

async function headless(session: Session, args: CliArgs): Promise<number> {
  let prompt = args.prompt;
  if (!process.stdin.isTTY) {
    const piped = (await readStdin()).trim();
    prompt = [prompt, piped].filter(Boolean).join("\n\n");
  }
  if (!prompt) { process.stderr.write("glitter: -p needs a prompt, as an argument or on stdin.\n"); return 2; }
  session.approve = async (approval) => {
    if (args.outputFormat === "text") process.stderr.write(`${paint.yellow("Denied")} ${safeText(approval.toolName)}: it needs approval. Run with --permission-mode full-access to allow it.\n`);
    return "deny";
  };
  let cancelled = false;
  process.once("SIGINT", () => { cancelled = true; void session.cancel(); });
  const end = await session.run(prompt);
  const { terminal, error } = outcomeOf(end);
  if (args.outputFormat === "json") {
    process.stdout.write(`${JSON.stringify({
      type: "result",
      sessionId: session.sessionId,
      turnId: end.turnId,
      outcome: terminal,
      text: diagnostics.text(end.text),
      ...(error ? { error } : {}),
      ...(end.questions.length ? { questions: end.questions.map((request) => ({ userInputId: request.userInputId, questions: request.questions })) } : {}),
    })}\n`);
  } else if (args.outputFormat === "stream-json") {
    process.stdout.write(`${JSON.stringify({ type: "result", sessionId: session.sessionId, turnId: end.turnId, outcome: terminal, ...(error ? { error } : {}) })}\n`);
  } else {
    if (end.text && !end.text.endsWith("\n")) process.stdout.write("\n");
    for (const request of end.questions) process.stderr.write(`${paint.yellow("The agent asked:")} ${request.questions.map((question) => safeText(question.question)).join(" ")}\nContinue with: glitter -r ${session.sessionId}\n`);
    if (error) process.stderr.write(`${paint.red("Error:")} ${safeText(error.message)}\n`);
  }
  if (cancelled || terminal === "cancelled") return 130;
  return terminal === "failed" ? 1 : 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolveText, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolveText(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

const CHAT_HELP = `Commands
  /new                 Start a new thread in this folder
  /model [id]          Show or set the model (see /models)
  /models              List available models
  /effort <level>      Set reasoning effort
  /mode <build|plan>   Plan reads and plans without editing
  /permissions [mode]  Show or set: read-only, ask, auto, full-access
  /compact             Summarize the history to free context
  /sessions            List this folder's threads
  /resume <id>         Switch to another thread
  /status              Show the thread, model and folder
  /exit                Quit`;

async function interactive(session: Session, args: CliArgs, workspaceRoot: string): Promise<number> {
  const out = process.stdout;
  const rl = createInterface({ input: process.stdin, output: out, terminal: Boolean(process.stdin.isTTY), historySize: 200 });
  let closed = false;
  const pipedLines: string[] = [];
  let pipedWaiter: ((answer: string | null) => void) | null = null;
  if (!process.stdin.isTTY) rl.on("line", (line) => {
    if (pipedWaiter) { const resolveAnswer = pipedWaiter; pipedWaiter = null; resolveAnswer(line); }
    else pipedLines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    if (pipedWaiter) { const resolveAnswer = pipedWaiter; pipedWaiter = null; resolveAnswer(null); }
  });
  const ask = (query: string) => new Promise<string | null>((resolveAnswer) => {
    if (!process.stdin.isTTY) {
      if (pipedLines.length) { out.write(query); resolveAnswer(pipedLines.shift()!); }
      else if (closed) resolveAnswer(null);
      else { out.write(query); pipedWaiter = resolveAnswer; }
      return;
    }
    if (closed) return resolveAnswer(null);
    const onClose = () => resolveAnswer(null);
    rl.once("close", onClose);
    rl.question(query, (answer) => { rl.off("close", onClose); resolveAnswer(answer); });
  });

  session.approve = async (approval) => approvalPrompt(approval, ask);
  let interrupts = 0;
  rl.on("SIGINT", () => {
    if (session.busy) {
      out.write(`\n${paint.dim("Stopping…")}\n`);
      void session.cancel();
      return;
    }
    interrupts += 1;
    if (interrupts >= 2) { rl.close(); return; }
    out.write(`\n${paint.dim("Press Ctrl+C again to quit.")}\n`);
    rl.prompt();
  });

  banner(session, workspaceRoot);
  for (const request of session.pending.splice(0)) {
    process.stdout.write(`${paint.yellow("This thread is waiting for your answer.")}\n`);
    const end = await session.answer(request, await questionPrompt(request, ask)).catch(() => null);
    if (end) {
      const { error } = outcomeOf(end);
      if (error) process.stdout.write(`${paint.red("Error:")} ${safeText(error.message)}\n`);
    }
  }
  let next: string | null = args.prompt || null;
  while (true) {
    const line = next ?? await ask(paint.accent("› "));
    next = null;
    if (line === null) break;
    interrupts = 0;
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith("/")) {
      const keepGoing = await command(text, session, workspaceRoot);
      if (!keepGoing) break;
      continue;
    }
    try {
      let end: TurnEnd | null = await session.run(text);
      while (end) {
        const { error, terminal } = outcomeOf(end);
        if (error) out.write(`${paint.red("Error:")} ${safeText(error.message)}${error.code ? paint.dim(` (${error.code})`) : ""}\n`);
        if (terminal === "cancelled") out.write(`${paint.dim("Stopped.")}\n`);
        const request = end.questions[0];
        if (!request || (closed && !pipedLines.length)) break;
        const response = await questionPrompt(request, ask);
        end = await session.answer(request, response);
      }
    } catch (error) {
      out.write(`${paint.red("Error:")} ${safeText(diagnostics.text(error instanceof Error ? error.message : String(error)))}\n`);
    }
  }
  rl.close();
  out.write(`${paint.dim(`Thread saved. Continue with: glitter -r ${session.sessionId}`)}\n`);
  return 0;
}

function banner(session: Session, workspaceRoot: string) {
  process.stdout.write(`${paint.bold("Glitter")} ${paint.dim(VERSION)}  ${paint.dim(workspaceRoot)}\n`);
  process.stdout.write(`${paint.dim(`${session.modelId || "default model"} · ${session.mode} · ${session.permission} · /help for commands`)}\n\n`);
}

/** Run one slash command. Returns false to quit. */
async function command(text: string, session: Session, workspaceRoot: string): Promise<boolean> {
  const [name, ...rest] = text.slice(1).split(/\s+/);
  const value = rest.join(" ").trim();
  const out = process.stdout;
  const host = session.host;
  try {
    switch (name) {
      case "exit": case "quit": case "q":
        return false;
      case "help": case "?":
        out.write(`${CHAT_HELP}\n`);
        return true;
      case "new": {
        const started = await host.startSession({ workspaceRoot, modelId: session.modelId || undefined, mode: session.mode, approvalMode: session.approvalMode }) as Json;
        session.sessionId = String(started.sessionId);
        out.write(`${paint.dim(`New thread ${session.sessionId}`)}\n`);
        return true;
      }
      case "models": {
        const { models } = await host.listModels(session.sessionId);
        out.write(models.map((model: HarnessModel) => `${model.modelId === session.modelId ? "*" : " "} ${model.modelId}`).join("\n") + "\n");
        return true;
      }
      case "model":
        if (!value) { out.write(`${session.modelId || "default"}\n`); return true; }
        await host.setModel({ sessionId: session.sessionId, modelId: value });
        session.modelId = value;
        out.write(`${paint.dim(`Model: ${value}`)}\n`);
        return true;
      case "effort":
        if (!value) { out.write("Usage: /effort <none|minimal|low|medium|high|xhigh|max>\n"); return true; }
        await host.setOption(session.sessionId, "effort", value);
        out.write(`${paint.dim(`Effort: ${value}`)}\n`);
        return true;
      case "mode":
        if (value !== "build" && value !== "plan") { out.write("Usage: /mode <build|plan>\n"); return true; }
        await host.setOption(session.sessionId, "mode", value);
        session.mode = value;
        out.write(`${paint.dim(`Mode: ${value}`)}\n`);
        return true;
      case "permissions": {
        if (!value) { out.write(`${session.permission}\n`); return true; }
        const mode = PERMISSIONS[value as PermissionName];
        if (!mode) { out.write(`Usage: /permissions <${Object.keys(PERMISSIONS).join("|")}>\n`); return true; }
        host.setApprovalMode(session.sessionId, mode);
        session.approvalMode = mode;
        out.write(`${paint.dim(`Permissions: ${value}`)}\n`);
        return true;
      }
      case "compact":
        await host.compactSession({ sessionId: session.sessionId });
        out.write(`${paint.dim("Compacting…")}\n`);
        return true;
      case "sessions":
        await listSessions(host, workspaceRoot);
        return true;
      case "resume": {
        if (!value) { out.write("Usage: /resume <id>\n"); return true; }
        const meta = (await host.listSessions()).sessions.find((row) => row.sessionId === value);
        if (!meta) { out.write(`No thread ${value}.\n`); return true; }
        await host.resumeSession({ sessionId: value, workspaceRoot: meta.workspaceRoot, approvalMode: session.approvalMode });
        session.sessionId = value;
        out.write(`${paint.dim(`Resumed ${safeText(meta.name ?? value)}`)}\n`);
        return true;
      }
      case "status":
        out.write(`Thread       ${session.sessionId}\nModel        ${session.modelId || "default"}\nMode         ${session.mode}\nPermissions  ${session.permission}\nFolder       ${workspaceRoot}\n`);
        return true;
      default:
        out.write(`Unknown command /${name}. Type /help.\n`);
        return true;
    }
  } catch (error) {
    out.write(`${paint.red("Error:")} ${safeText(diagnostics.text(error instanceof Error ? error.message : String(error)))}\n`);
    return true;
  }
}

async function approvalPrompt(approval: ApprovalEvent, ask: (query: string) => Promise<string | null>): Promise<string> {
  const out = process.stdout;
  const choices = approval.availableChoices?.length ? approval.availableChoices : [{ choiceId: "allow-once", label: "Allow once" }, { choiceId: "deny", label: "Deny" }];
  out.write(`\n${paint.yellow("Approval needed")} ${paint.bold(safeText(approval.toolName))}\n`);
  const summary = approvalSummary(approval);
  if (summary) out.write(`  ${summary}\n`);
  if (approval.subject?.risk) out.write(`  ${paint.yellow(safeText(approval.subject.risk))}\n`);
  choices.forEach((choice, at) => out.write(`  ${at + 1}. ${safeText(choice.label)}${choice.scopeLabel ? paint.dim(` — ${safeText(choice.scopeLabel)}`) : ""}\n`));
  for (;;) {
    const answer = await ask(paint.accent(`Choose 1-${choices.length} › `));
    if (answer === null) return "deny";
    const picked = Number(answer.trim());
    if (Number.isInteger(picked) && picked >= 1 && picked <= choices.length) return choices[picked - 1].choiceId;
    const typed = answer.trim().toLowerCase();
    if (typed === "y" || typed === "yes") return choices[0].choiceId;
    if (typed === "n" || typed === "no" || typed === "") return "deny";
  }
}

function approvalSummary(approval: ApprovalEvent): string {
  let input: Json = {};
  try { input = JSON.parse(approval.rawArgs ?? "{}") as Json; } catch { /* shown raw below */ }
  if (typeof input.command === "string") return paint.dim(`$ ${safeText(input.command)}`);
  if (typeof input.path === "string") return paint.dim(safeText(input.path));
  if (approval.subject?.path) return paint.dim(safeText(approval.subject.path));
  return approval.rawArgs ? paint.dim(safeText(approval.rawArgs).slice(0, 200)) : "";
}

async function questionPrompt(request: UserInputRequest, ask: (query: string) => Promise<string | null>): Promise<UserInputResponse> {
  const out = process.stdout;
  if (request.intent?.kind === "planReview") out.write(`\n${paint.bold("Plan")}\n${safeText(request.intent.plan)}\n`);
  const answers: Array<{ questionId: string; selectedLabel?: string; selectedLabels?: string[]; freeText?: string }> = [];
  for (const question of request.questions) {
    out.write(`\n${paint.bold(safeText(question.header || "Question"))} ${safeText(question.question)}\n`);
    question.options.forEach((option, at) => out.write(`  ${at + 1}. ${safeText(option.label)}${option.description ? paint.dim(` — ${safeText(option.description)}`) : ""}\n`));
    const multiple = question.selection.mode === "multiple";
    const hint = question.options.length ? (multiple ? "numbers separated by commas, or your own answer" : "a number, or your own answer") : "your answer";
    const answer = await ask(paint.accent(`Answer (${hint}; empty to cancel) › `));
    if (answer === null || !answer.trim()) return { action: "cancel" };
    const picks = answer.split(",").map((part) => Number(part.trim()));
    const labels = picks.every((pick) => Number.isInteger(pick) && pick >= 1 && pick <= question.options.length) ? picks.map((pick) => question.options[pick - 1].label) : [];
    if (labels.length && multiple) answers.push({ questionId: question.id, selectedLabels: labels });
    else if (labels.length === 1) answers.push({ questionId: question.id, selectedLabel: labels[0] });
    else answers.push({ questionId: question.id, freeText: answer.trim() });
  }
  return { action: "answer", answers };
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
  // MCP servers and timers may hold the loop open after the last turn.
  setTimeout(() => process.exit(code), 100).unref();
}, (error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`glitter: ${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`glitter: ${diagnostics.text(error instanceof Error ? error.message : String(error))}\n`);
  process.exit(1);
});
