import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveMuseBin } from "./detect.js";
import { filterChildEnv } from "./isolation.js";
import { forgetProbe } from "./probe-cache.js";

/**
 * Muse CLI release-channel checks and updates, mirroring `muse-launcher.sh`.
 *
 * The `muse` executable is a launcher: it keeps a versioned binary
 * (`muse-bin-<version>`) in its own directory, records the active release in
 * `.muse-version`, and polls the channel manifest hourly (in the background).
 * There is no `muse upgrade` verb — a synchronous update is just any launcher
 * run with `MUSE_SYNC_UPDATE=1`, so the update command and the version probe
 * are literally the same argv (`--version`).
 */

export const CLI_CHANNELS = ["muse-stable", "muse-canary"] as const;
export type CliChannel = (typeof CLI_CHANNELS)[number];

/** Channel-manifest root, as pinned by the launcher (not user-configurable). */
export const CLI_CHANNEL_URL = "https://api.meta.ai/muse-code/channels";
/** The launcher's `json_max_bytes`: a bigger document never parses there either. */
const CHANNEL_MANIFEST_BUDGET = 8192;
const CHANNEL_FETCH_TIMEOUT_MS = 10_000;
/** A release download can take a while; the renderer budgets past this. */
const UPDATE_TIMEOUT_MS = 5 * 60_000;
/** The launcher's `version_pattern`: `1.2.3-R4`, with an optional trailing `.5`. */
const VERSION_PATTERN = /^[0-9]+[.][0-9]+[.][0-9]+-R[0-9]+([.][0-9]+)?$/;
/** Launcher state files are tab- and newline-delimited; code points, not escapes. */
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);

export type CliUpdateUrgency = "none" | "encouraged" | "must_download";

export type ChannelManifest = {
  channel: string;
  version: string;
  manifestUrl: string;
  urgency: CliUpdateUrgency;
  notification: string;
};

export type CliUpdateStatus = {
  available: boolean;
  /** Installed channel version (`3.14.4-R2`); null when not launcher-managed. */
  current: string | null;
  /** Channel version; null when the check could not run or failed. */
  latest: string | null;
  urgency: CliUpdateUrgency;
  /** Channel `notification_text`: the release notes shown beside the update. */
  notification: string;
  channel: string;
};

export type CliUpdateOutcome = {
  updated: boolean;
  from: string | null;
  to: string | null;
  /** New channel version, else the `--version` print for display. */
  version: string | null;
};

export function cliChannel(env: NodeJS.ProcessEnv = process.env): CliChannel {
  const channel = env.MUSE_CHANNEL?.trim() || "muse-stable";
  if (channel !== "muse-stable" && channel !== "muse-canary") throw new Error(`Unsupported Muse channel: ${channel}.`);
  return channel;
}

export function channelManifestUrl(channel: string): string {
  return `${CLI_CHANNEL_URL}/${channel}`;
}

/** The launcher's `json_is_clean`: tab, CR, LF, and FS disqualify a URL. */
function hasControlByte(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13 || code === 31) return true;
  }
  return false;
}

/** Mirror of the launcher's `parse_channel_manifest`: same fields, same version pattern. */
export function parseChannelManifest(text: string, channel: string): ChannelManifest {
  if (text.length > CHANNEL_MANIFEST_BUDGET) throw new Error("Channel manifest exceeds the size budget.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Channel manifest is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Channel manifest is not an object.");
  const record = parsed as Record<string, unknown>;
  if (record.channel !== channel) throw new Error("Channel manifest is for a different channel.");
  if (typeof record.version !== "string" || !VERSION_PATTERN.test(record.version)) throw new Error("Channel manifest carries no usable version.");
  // The URL itself is never fetched here; it only has to be present and clean.
  if (typeof record.manifest_url !== "string" || !record.manifest_url || hasControlByte(record.manifest_url)) {
    throw new Error("Channel manifest carries no usable manifest URL.");
  }
  if (record.urgency !== "none" && record.urgency !== "encouraged" && record.urgency !== "must_download") {
    throw new Error("Channel manifest carries no usable urgency.");
  }
  if (typeof record.notification_text !== "string") throw new Error("Channel manifest carries no notification text.");
  return { channel, version: record.version, manifestUrl: record.manifest_url, urgency: record.urgency, notification: record.notification_text };
}

/** The install dir is the launcher's own directory with symlinks resolved. */
export function installDirForBin(bin: string): string | null {
  try {
    return dirname(realpathSync(bin));
  } catch {
    return null;
  }
}

/** Installed channel version from `.muse-version`; null when not launcher-managed. */
export function installedCliVersion(installDir: string): string | null {
  try {
    const version = readFileSync(join(installDir, ".muse-version"), "utf8").trim();
    return VERSION_PATTERN.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Pending `from`-tab-`to` notice the launcher leaves after an update.
 * Read-only here: the file is the launcher's to claim, so a terminal run
 * still reports an update the app applied.
 */
export function pendingUpdateNotice(installDir: string): { from: string; to: string } | null {
  try {
    const [from, to] = readFileSync(join(installDir, ".muse-update-notice"), "utf8").trim().split(TAB);
    if (!from || !to || from === to || !VERSION_PATTERN.test(from) || !VERSION_PATTERN.test(to)) return null;
    return { from, to };
  } catch {
    return null;
  }
}

type FetchImpl = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; body?: unknown }>;

/**
 * Read the channel manifest without buffering an unbounded response: when the
 * fetch result exposes a body stream, the read aborts at the budget instead of
 * pulling whatever a misbehaving endpoint sends into memory.
 */
async function readManifest(response: { body?: unknown; text: () => Promise<string> }): Promise<string> {
  const body = response.body;
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      if (received > CHANNEL_MANIFEST_BUDGET * 8) throw new Error("Channel manifest exceeds the size budget.");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return response.text();
}

/**
 * Compare the installed CLI against its release channel. Non-launcher
 * installs (no `.muse-version` beside the binary) report no update rather
 * than a version this check cannot compare.
 */
export async function checkCliUpdate(options: { museBin?: string | null; fetchImpl?: FetchImpl } = {}): Promise<CliUpdateStatus> {
  const channel = cliChannel();
  const none: CliUpdateStatus = { available: false, current: null, latest: null, urgency: "none", notification: "", channel };
  const bin = resolveMuseBin(options.museBin);
  if (!bin) return none;
  const installDir = installDirForBin(bin);
  const current = installDir ? installedCliVersion(installDir) : null;
  if (!current) return none;
  const fetchImpl: FetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHANNEL_FETCH_TIMEOUT_MS);
  try {
    // The channel manifest needs no auth (the launcher fetches it bare too);
    // only the release manifest and artifact may ask for a sign-in.
    const response = await fetchImpl(channelManifestUrl(channel), {
      headers: { Accept: "application/json", "User-Agent": "muse-code-desktop" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Channel request failed (HTTP ${response.status}).`);
    const manifest = parseChannelManifest(await readManifest(response), channel);
    return { available: manifest.version !== current, current, latest: manifest.version, urgency: manifest.urgency, notification: manifest.notification, channel };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Channel request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** One synchronous launcher update: the only supported update path. */
function runSyncUpdate(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ["--version"], {
      timeout: UPDATE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      // An explicit update is consent for this one run even where the ambient
      // shell opted out of background updates; nothing here persists.
      env: { ...filterChildEnv(process.env, "muse"), MUSE_SYNC_UPDATE: "1", MUSE_NO_AUTO_UPDATE: "0" },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = `${stderr ?? ""}${stdout ?? ""}`.trim().split(LF).slice(-3).join(" ").slice(0, 500);
        reject(new Error(detail ? `Muse update failed: ${detail}` : `Muse update failed: ${String(error.message ?? error)}`));
        return;
      }
      resolve(`${stdout ?? ""}${stderr ?? ""}`.trim());
    });
  });
}

/**
 * Run the launcher's synchronous update and report what changed. Already
 * current is a success with `updated: false`, never an error. The version
 * probe cache is dropped: the launcher swaps binaries without changing
 * itself, so every cached print is stale from here on.
 */
export async function updateCli(options: { museBin?: string | null; runSyncUpdateImpl?: (bin: string) => Promise<string> } = {}): Promise<CliUpdateOutcome> {
  const bin = resolveMuseBin(options.museBin);
  if (!bin) throw new Error("Muse CLI was not found. Install it, then try again.");
  const installDir = installDirForBin(bin);
  const before = installDir ? installedCliVersion(installDir) : null;
  const output = await (options.runSyncUpdateImpl ?? runSyncUpdate)(bin);
  forgetProbe(bin);
  const after = installDir ? installedCliVersion(installDir) : null;
  const notice = installDir ? pendingUpdateNotice(installDir) : null;
  const to = after ?? notice?.to ?? null;
  const banner = output.trim();
  return { updated: Boolean(before && to && before !== to), from: before, to, version: to ?? (banner ? banner : null) };
}
