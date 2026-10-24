import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

/** A native-reviewed byte-exact identity for MCP startup configuration. */
function hash(parts: readonly (string | Buffer)[]): string {
  const digest = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(length);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

/** One safe byte source for both the native-reviewed identity and the parser. */
export async function readMcpConfigBytes(root: string): Promise<Buffer> {
  const folder = join(root, ".glitter");
  const path = join(folder, "mcp.json");
  try {
    if ((await lstat(folder)).isSymbolicLink()) throw new Error(`${folder} must not be a symbolic link.`);
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`${path} must not be a symbolic link.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
  if (bytes.length > 64 * 1024) throw new Error(`${path} is too large.`);
  return bytes;
}

export async function mcpConfigFingerprints(workspaceRoot: string, homeDir: string) {
  const [workspace, home] = await Promise.all([readMcpConfigBytes(workspaceRoot), readMcpConfigBytes(homeDir)]);
  return {
    configurationDigest: hash([workspaceRoot, workspace, home]),
    ...(home.length ? { homeConfigurationDigest: hash([home]) } : {}),
  };
}
