import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { detectMuse } from "./detect.js";

/**
 * Coding-agent CLIs this app can drive. Muse speaks MSP through its SDK; the rest
 * speak ACP (Agent Client Protocol, JSON-RPC over stdio). Only binaries named here
 * are ever spawned — detection never runs arbitrary paths.
 */
/** `harness` is the app's own agent (see harness/host.ts): no binary, no ACP. */
export type AgentId = "muse" | "opencode" | "grok" | "gemini" | "qwen" | "goose" | "cline" | "harness";

export type AgentSpec = {
  id: Exclude<AgentId, "harness">;
  name: string;
  protocol: "msp" | "acp";
  bins: string[];
  /** Arguments that start the ACP server over stdio. */
  acpArgs?: string[];
  /** Extra install locations beyond PATH. */
  dirs?: string[];
  /** Verified end-to-end against a real install; others are best-effort ACP. */
  verified: boolean;
  signIn: string;
};

const home = homedir();
const COMMON_DIRS = [
  join(home, ".local", "bin"),
  join(home, ".bun", "bin"),
  join(home, ".npm-global", "bin"),
  join(home, ".volta", "bin"),
  join(home, ".asdf", "shims"),
  join(home, ".nvm", "current", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

export const AGENTS: AgentSpec[] = [
  { id: "muse", name: "Muse", protocol: "msp", bins: ["muse"], verified: true, signIn: "Run `muse` and `/login` for a Muse Code subscription, or add an API key in Settings." },
  { id: "opencode", name: "OpenCode", protocol: "acp", bins: ["opencode"], acpArgs: ["acp"], dirs: [join(home, ".opencode", "bin")], verified: true, signIn: "Run `opencode auth login` in a terminal, then Rescan." },
  { id: "grok", name: "Grok", protocol: "acp", bins: ["grok"], acpArgs: ["agent", "stdio"], dirs: [join(home, ".grok", "bin")], verified: true, signIn: "Run `grok login` in a terminal, then Rescan." },
  { id: "gemini", name: "Gemini CLI", protocol: "acp", bins: ["gemini"], acpArgs: ["--experimental-acp"], verified: false, signIn: "Run `gemini` once in a terminal to sign in." },
  { id: "qwen", name: "Qwen Code", protocol: "acp", bins: ["qwen"], acpArgs: ["--experimental-acp"], verified: false, signIn: "Run `qwen` once in a terminal to sign in." },
  { id: "goose", name: "Goose", protocol: "acp", bins: ["goose"], acpArgs: ["acp"], verified: false, signIn: "Run `goose configure` in a terminal." },
  { id: "cline", name: "Cline CLI", protocol: "acp", bins: ["cline"], acpArgs: ["--acp"], verified: false, signIn: "Run `cline auth` in a terminal, then Rescan." },
];

export function agentSpec(id: string): AgentSpec {
  const spec = AGENTS.find((agent) => agent.id === id);
  if (!spec) throw new Error(`Unknown agent: ${id}`);
  return spec;
}

function isTempTarget(resolved: string): boolean {
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  return normalized.startsWith("/tmp/") || normalized.startsWith("/var/tmp/")
    || normalized.startsWith("/private/tmp/") || normalized.includes("/appdata/local/temp/");
}

export function resolveAgentBin(spec: AgentSpec): string | null {
  const dirs = [...(spec.dirs ?? []), ...COMMON_DIRS, ...(process.env.PATH ?? "").split(delimiter)].filter(Boolean);
  for (const dir of dirs) {
    for (const name of spec.bins) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      // Fallback resolution only (Tauri injects the checked path): still
      // canonicalize and skip temp targets instead of spawning them.
      let resolved: string;
      try {
        resolved = realpathSync(candidate);
      } catch {
        continue;
      }
      if (!isTempTarget(resolved)) return resolved;
    }
  }
  return null;
}

/**
 * Canonicalize a binary path supplied by the caller. The native shell already
 * resolves, validates and injects this itself, so this is defence in depth for
 * direct invocations (dev, smoke scripts, any looser caller): a path we are
 * about to spawn must be a real file outside temporary directories, exactly as
 * the fallback PATH walk requires, and never whatever a caller nominates.
 */
export function checkAgentBin(raw: string): string | null {
  if (!raw.trim()) return null;
  try {
    const resolved = realpathSync(raw);
    return isTempTarget(resolved) ? null : resolved;
  } catch {
    return null;
  }
}

export type AgentInfo = {
  id: AgentId;
  name: string;
  protocol: "msp" | "acp" | "native";
  found: boolean;
  path: string | null;
  version: string | null;
  verified: boolean;
  signIn: string;
  /** Muse only: whether the chosen credential is present. ACP agents report auth on connect. */
  authenticated?: boolean;
};

export async function detectAgents(museBin?: string | null, museApiKey?: string | null, museAuthMode?: string | null, harnessProviders: string[] = []): Promise<AgentInfo[]> {
  // ACP detection is metadata-only: authorized native code probes versions after
  // the identity check, never an unapproved binary found during a Settings scan.
  const found = new Map<AgentId, string>();
  for (const spec of AGENTS) {
    if (spec.id === "muse") continue;
    const path = resolveAgentBin(spec);
    if (path) found.set(spec.id, path);
  }
  const muse = detectMuse(museBin, museApiKey, museAuthMode);
  // The built-in agent ships with the app; it is ready once a provider is configured.
  const harness: AgentInfo = { id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "Add an API key for a model provider in Settings → Providers.", authenticated: harnessProviders.length > 0 };
  return [harness, ...await Promise.all(AGENTS.map(async (spec): Promise<AgentInfo> => {
    if (spec.id === "muse") {
      const detection = await muse;
      return { id: spec.id, name: spec.name, protocol: spec.protocol, found: detection.found, path: detection.path, version: detection.version?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? detection.version, verified: true, signIn: spec.signIn, authenticated: detection.authenticated };
    }
    const path = found.get(spec.id);
    return { id: spec.id, name: spec.name, protocol: spec.protocol, found: Boolean(path), path: path ?? null, version: null, verified: spec.verified, signIn: spec.signIn };
  }))];
}
