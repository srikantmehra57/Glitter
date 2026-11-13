import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { metadataPlugin, STANDALONE_BANNER } from "./playwright-metadata.mjs";

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, "..", "src", "index.ts")],
  outfile: join(here, "..", "dist", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "bundle",
  plugins: [metadataPlugin],
  banner: { js: `#!/usr/bin/env node\n${STANDALONE_BANNER}` },
  logLevel: "info",
});

// The `glitter` command: the same Harness engine, driven from a terminal.
const { version } = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
await build({
  entryPoints: [join(here, "..", "src", "cli.ts")],
  outfile: join(here, "..", "dist", "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "bundle",
  plugins: [metadataPlugin],
  define: { __GLITTER_VERSION__: JSON.stringify(version) },
  banner: { js: `#!/usr/bin/env node\n${STANDALONE_BANNER}` },
  logLevel: "info",
});
