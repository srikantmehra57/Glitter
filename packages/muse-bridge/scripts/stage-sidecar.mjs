#!/usr/bin/env node
/**
 * Stage the bridge sidecar runtime for Tauri `externalBin` distribution.
 *
 * Release builds spawn ONLY this bundled Node — never an ambient `node`
 * (SEC-02). The script downloads the official nodejs.org binary for the host
 * triple, verifies SHASUMS256.txt.asc with the pinned Node release key, checks
 * the archive against that signed checksum and the pin below, and stages the
 * binary at `apps/desktop/src-tauri/binaries/` (gitignored; the release
 * pipeline stages one per macOS architecture). The staged runtime is signed with
 * the app bundle, and the Rust side verifies its digest before every spawn.
 * The OpenPGP signature is checked in-process. The unsigned SHASUMS256.txt
 * is never trusted.
 *
 * Single-executable (SEA) packaging was evaluated and rejected: its injector
 * (`postject`, abandoned 2023) cannot parse current Node Mach-O binaries.
 * Bundling the stock runtime keeps dev/prod behavior identical.
 *
 * Usage: npm run build:sidecar -w @muse/bridge
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checksumMap, verifySignedChecksums } from "./verify-node-release.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const outDir = join(pkg, "..", "..", "apps", "desktop", "src-tauri", "binaries");

// Pinned for reproducible, dev/prod-identical releases. Bump deliberately.
const NODE_VERSION = "v26.8.2";
const PINNED_SHA256 = {
  "darwin-arm64.tar.gz": "974b6d5fb2fc7c33ff2354db0902b4e91c2de01ec8acc6de48e543c97e18c9e1",
  "darwin-x64.tar.gz": "adb8feb2d4987df3d72d2ec46f4fc4b58039c859b8c3f0e3cc2d3c6cbaf8629c",
};

const TARGETS = {
  "darwin-arm64": { dist: "darwin-arm64.tar.gz", member: "bin/node", out: "muse-node-aarch64-apple-darwin" },
  "darwin-x64": { dist: "darwin-x64.tar.gz", member: "bin/node", out: "muse-node-x86_64-apple-darwin" },
};

const key = `${process.platform}-${process.arch}`;
const target = TARGETS[key];
if (!target) throw new Error(`Unsupported sidecar target: ${key}`);
const pinnedSha256 = PINNED_SHA256[target.dist];
if (!pinnedSha256) throw new Error(`Missing pinned SHA-256 for ${target.dist}; add one when bumping NODE_VERSION.`);

const base = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${target.dist}`;
const work = mkdtempSync(join(tmpdir(), "muse-sidecar-"));
mkdirSync(outDir, { recursive: true });

async function download(url, dest, timeoutMs, description) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const file = createWriteStream(dest);
    await response.body.pipeTo(new WritableStream({ write: (chunk) => file.write(chunk), close: () => file.end() }));
    await new Promise((resolve, reject) => {
      file.on("finish", resolve);
      file.on("error", reject);
    });
  } catch (error) {
    if (signal.aborted && signal.reason?.name === "TimeoutError") {
      const timeout = timeoutMs === 600_000 ? "10 minutes" : `${timeoutMs / 1000} seconds`;
      throw new Error(`Timed out downloading ${description} after ${timeout}: ${url}`);
    }
    throw error;
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const archive = join(work, "node.tar.gz");
const sumsFile = join(work, "SHASUMS256.txt.asc");
await download(base, archive, 600_000, "Node archive");
await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt.asc`, sumsFile, 30_000, "Node SHASUMS256.txt.asc");

const fileName = base.split("/").pop();
const sums = checksumMap(await verifySignedChecksums(sumsFile));
if (!sums[fileName]) throw new Error(`No signed checksum published for ${fileName}`);
const archiveSha256 = sha256(archive).toLowerCase();
if (archiveSha256 !== pinnedSha256.toLowerCase()) {
  throw new Error(`Pinned SHA-256 mismatch for ${target.dist}: expected ${pinnedSha256}, got ${archiveSha256}; refusing to stage.`);
}
if (archiveSha256 !== sums[fileName]) {
  throw new Error(`Signed SHA-256 mismatch for ${fileName}; refusing to stage.`);
}

// Extract the archive, then stage only the runtime binary.
execFileSync("tar", ["-xf", archive, "-C", work], { stdio: "inherit" });
const extracted = join(work, `node-${NODE_VERSION}-${target.dist.replace(/\.tar\.gz$/, "")}`, target.member);

const binary = join(outDir, target.out);
copyFileSync(extracted, binary);
chmodSync(binary, 0o755);
rmSync(work, { recursive: true, force: true });
console.log(`sidecar: ${binary} (sha256 ${sha256(binary).slice(0, 16)}…)`);
