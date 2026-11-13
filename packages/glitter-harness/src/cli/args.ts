/**
 * Command-line arguments for `glitter`. Pure: no I/O, so it is tested directly.
 */

export type OutputFormat = "text" | "json" | "stream-json";
export type PermissionName = "read-only" | "ask" | "auto" | "full-access";

export type CliArgs = {
  command: "chat" | "models" | "sessions" | "help" | "version";
  /** Headless: run one prompt and exit. */
  print: boolean;
  prompt: string;
  outputFormat: OutputFormat;
  model?: string;
  effort?: string;
  mode?: "build" | "plan";
  permission?: PermissionName;
  cwd?: string;
  resume?: string;
  continueLast: boolean;
  /** Start the MCP servers configured for this folder and in the home folder. */
  mcp: boolean;
  keychain: boolean;
  verbose: boolean;
};

/** CLI permission names and the Harness approval modes they select (the app's labels, kebab-cased). */
export const PERMISSIONS: Record<PermissionName, "denyUnmatched" | "onRequest" | "guarded" | "allowAll"> = {
  "read-only": "denyUnmatched",
  ask: "onRequest",
  auto: "guarded",
  "full-access": "allowAll",
};

export const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json", "stream-json"];

export class UsageError extends Error {}

const VALUE_FLAGS: Record<string, keyof CliArgs> = {
  "-m": "model", "--model": "model",
  "--effort": "effort",
  "--mode": "mode",
  "--permission-mode": "permission", "--permissions": "permission",
  "-C": "cwd", "--cwd": "cwd",
  "-r": "resume", "--resume": "resume",
  "--output-format": "outputFormat",
};

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { command: "chat", print: false, prompt: "", outputFormat: "text", continueLast: false, mcp: false, keychain: true, verbose: false };
  const words: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    const raw = argv[at];
    if (raw === "--") { words.push(...argv.slice(at + 1)); break; }
    const [flag, inline] = raw.startsWith("--") && raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
    if (flag === "-h" || flag === "--help") { args.command = "help"; continue; }
    if (flag === "-v" || flag === "--version") { args.command = "version"; continue; }
    if (flag === "-p" || flag === "--print") { args.print = true; continue; }
    if (flag === "-c" || flag === "--continue") { args.continueLast = true; continue; }
    if (flag === "--mcp") { args.mcp = true; continue; }
    if (flag === "--no-keychain") { args.keychain = false; continue; }
    if (flag === "--verbose") { args.verbose = true; continue; }
    const key = VALUE_FLAGS[flag];
    if (key) {
      const value = inline ?? argv[at + 1];
      if (value === undefined || (inline === undefined && value.startsWith("-") && value.length > 1)) throw new UsageError(`${flag} needs a value.`);
      if (inline === undefined) at += 1;
      setValue(args, key, flag, value);
      continue;
    }
    if (raw.startsWith("-") && raw.length > 1) throw new UsageError(`Unknown option: ${raw}`);
    words.push(raw);
  }
  // A leading subcommand word, only when nothing else would make it a prompt.
  if (args.command === "chat" && !args.print && words.length === 1 && (words[0] === "models" || words[0] === "sessions")) {
    args.command = words[0];
    words.length = 0;
  }
  args.prompt = words.join(" ").trim();
  if (args.resume && args.continueLast) throw new UsageError("Use --resume or --continue, not both.");
  if (args.outputFormat !== "text" && !args.print) throw new UsageError("--output-format applies only with -p.");
  return args;
}

function setValue(args: CliArgs, key: keyof CliArgs, flag: string, value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new UsageError(`${flag} needs a value.`);
  if (key === "mode") {
    if (trimmed !== "build" && trimmed !== "plan") throw new UsageError("--mode must be build or plan.");
    args.mode = trimmed;
  } else if (key === "permission") {
    if (!(trimmed in PERMISSIONS)) throw new UsageError(`--permission-mode must be one of ${Object.keys(PERMISSIONS).join(", ")}.`);
    args.permission = trimmed as PermissionName;
  } else if (key === "outputFormat") {
    if (!(OUTPUT_FORMATS as readonly string[]).includes(trimmed)) throw new UsageError(`--output-format must be one of ${OUTPUT_FORMATS.join(", ")}.`);
    args.outputFormat = trimmed as OutputFormat;
  } else {
    (args as Record<string, unknown>)[key] = trimmed;
  }
}

export const HELP = `Glitter — the Harness coding agent in your terminal.

Usage
  glitter [options] [prompt]        Chat in this folder. A prompt starts the chat with it.
  glitter -p "prompt" [options]     Run one prompt, print the reply and exit.
  glitter models                    List the models your providers offer.
  glitter sessions                  List this folder's threads.

Options
  -p, --print                 Run headless. Reads the prompt from stdin when none is given.
      --output-format <fmt>   text (default), json or stream-json. Only with -p.
  -m, --model <provider/id>   Model to use, for example anthropic/claude-sonnet-5-5.
      --effort <level>        Reasoning effort: none, minimal, low, medium, high, xhigh or max.
      --mode <build|plan>     Plan reads and plans without editing. Default: build.
      --permission-mode <m>   read-only, ask (default), auto or full-access.
  -C, --cwd <dir>             Folder to work in. Default: the current folder.
  -c, --continue              Continue the latest thread in this folder.
  -r, --resume <id>           Continue a thread by id.
      --mcp                   Start the MCP servers configured for this folder and your home folder.
      --no-keychain           Use only provider keys from environment variables.
      --verbose               Show reasoning and full tool output.
  -h, --help                  Show this help.
  -v, --version               Show the version.

Provider keys come from Glitter's Settings → Providers (the macOS Keychain).
Environment variables override them: ANTHROPIC_API_KEY, OPENAI_API_KEY,
GEMINI_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY,
MISTRAL_API_KEY, NVIDIA_API_KEY, CLINE_API_KEY and KILO_API_KEY.

Threads are saved with the app's, so a thread started here opens in Glitter.
In a headless run, a step that needs approval is denied unless
--permission-mode full-access is set.

In a chat, type /help for commands. Ctrl+C stops a running turn; press it
twice at the prompt to quit.`;
