import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDERS, nativeProviderCredentials, type ProviderCredentials } from "../harness/providers.js";
import type { PermissionRule } from "../harness/permission/rules.js";

/**
 * What the CLI shares with the app: provider keys from the app's Keychain
 * entry, the app's data folder (so threads appear in both), and the app's
 * defaults. Every read is best-effort: a missing app leaves the CLI usable
 * with environment variables alone.
 */

/** The app's bundle identifier: its Keychain service and its data folder name. */
export const APP_IDENTIFIER = "com.glitter.desktop";
const KEYCHAIN_ACCOUNT = "provider-keys";

export function appDataDir(home = homedir(), platform = process.platform): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", APP_IDENTIFIER);
  return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), APP_IDENTIFIER);
}

/** The Harness session folder. `GLITTER_HARNESS_DIR` wins, as it does for the app's agent process. */
export function harnessDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.GLITTER_HARNESS_DIR || join(appDataDir(), "harness");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Environment variables per provider id, first match wins. */
export const PROVIDER_ENV: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  cline: ["CLINE_API_KEY"],
  kilo: ["KILO_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
};

/**
 * Address overrides, named as the providers' own SDKs name them. The Anthropic
 * variable is the API host without `/v1`; the OpenAI one includes it.
 */
export const PROVIDER_BASE_ENV: Record<string, { name: string; suffix: string }> = {
  anthropic: { name: "ANTHROPIC_BASE_URL", suffix: "/v1" },
  openai: { name: "OPENAI_BASE_URL", suffix: "" },
};

/** An address a key may be sent to: https anywhere, plain http only to this machine. Mirrors the app's check. */
export function safeBaseUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password) return null;
  return url.toString().replace(/\/+$/, "");
}

/** Keys and addresses from the environment, as credential entries. */
export function envCredentials(env: NodeJS.ProcessEnv): ProviderCredentials {
  const credentials: ProviderCredentials = {};
  for (const [id, names] of Object.entries(PROVIDER_ENV)) {
    const key = names.map((name) => env[name]?.trim()).find(Boolean);
    if (key) credentials[id] = { key };
  }
  for (const [id, { name, suffix }] of Object.entries(PROVIDER_BASE_ENV)) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const base = safeBaseUrl(raw);
    if (!base) throw new Error(`${name} must be an https address, or http on this machine.`);
    credentials[id] = { ...credentials[id], baseUrl: suffix && !base.endsWith(suffix) ? `${base}${suffix}` : base };
  }
  return credentials;
}

/**
 * The app's saved providers. `security` prints the secret, or its hex form
 * when it holds bytes outside printable ASCII. macOS may ask once whether
 * `security` may read the item; the answer is the user's.
 */
export function keychainCredentials(run: (args: string[]) => string = runSecurity): ProviderCredentials {
  let raw: string;
  try {
    raw = run(["find-generic-password", "-s", APP_IDENTIFIER, "-a", KEYCHAIN_ACCOUNT, "-w"]).trim();
  } catch {
    return {};
  }
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0 && !raw.startsWith("{")) raw = Buffer.from(raw, "hex").toString("utf8");
  try {
    return nativeProviderCredentials(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

function runSecurity(args: string[]): string {
  return execFileSync("/usr/bin/security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 });
}

/** Keychain providers with environment keys laid over them. A custom endpoint keeps its address. */
export function loadCredentials(options: { keychain: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; read?: (args: string[]) => string }): ProviderCredentials {
  const env = options.env ?? process.env;
  const fromKeychain = options.keychain && (options.platform ?? process.platform) === "darwin" ? keychainCredentials(options.read) : {};
  const merged: ProviderCredentials = { ...fromKeychain };
  for (const [id, credential] of Object.entries(envCredentials(env))) merged[id] = { ...merged[id], ...credential };
  // Registers every key with the redactor, so no error or log can print one.
  return nativeProviderCredentials(merged) ?? {};
}

/** Known provider names, for messages. */
export function providerName(id: string): string {
  return PROVIDERS.find((provider) => provider.id === id)?.name ?? id;
}

export type AppDefaults = {
  modelId?: string;
  effort?: string;
  approvalMode?: string;
  rules: PermissionRule[];
};

/** The app's saved defaults and permission rules from its settings file. */
export function appDefaults(file = join(appDataDir(), "glitter.json")): AppDefaults {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { settings?: unknown };
    if (parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)) settings = parsed.settings as Record<string, unknown>;
  } catch {
    return { rules: [] };
  }
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const rules = Array.isArray(settings.harnessRules)
    ? (settings.harnessRules as Array<{ effect?: unknown; rule?: unknown }>)
      .filter((entry) => entry && (entry.effect === "allow" || entry.effect === "deny") && typeof entry.rule === "string")
      .map((entry) => ({ effect: entry.effect as "allow" | "deny", rule: entry.rule as string }))
    : [];
  const modelId = text(settings.defaultModel);
  return {
    // Harness models are `provider/model`. An id saved for an earlier agent has no provider and is ignored.
    ...(modelId?.includes("/") ? { modelId } : {}),
    ...(text(settings.defaultEffort) ? { effort: text(settings.defaultEffort) } : {}),
    ...(text(settings.defaultApprovalMode) ? { approvalMode: text(settings.defaultApprovalMode) } : {}),
    rules,
  };
}
