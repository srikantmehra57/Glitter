#!/usr/bin/env node
/**
 * Install the `glitter` command: a small launcher that runs the CLI shipped
 * inside Glitter.app with the app's own bundled Node runtime, so the command
 * needs no Node install and always matches the installed app.
 *
 * Usage: npm run install:cli [-- --app /Applications/Glitter.app] [--bin ~/.local/bin]
 *        npm run install:cli -- --uninstall
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? resolve(args[at + 1]) : fallback;
};
const app = option("--app", "/Applications/Glitter.app");
const binDir = option("--bin", join(homedir(), ".local", "bin"));
const launcher = join(binDir, "glitter");
const MARKER = "# Installed by Glitter's install:cli.";

const owned = () => existsSync(launcher) && readFileSync(launcher, "utf8").includes(MARKER);

if (args.includes("--uninstall")) {
  if (!existsSync(launcher)) { console.log(`Nothing to remove at ${launcher}.`); process.exit(0); }
  if (!owned()) { console.error(`${launcher} was not installed by Glitter; left it alone.`); process.exit(1); }
  rmSync(launcher);
  console.log(`Removed ${launcher}.`);
  process.exit(0);
}

const node = join(app, "Contents", "MacOS", "glitter-node");
const cli = join(app, "Contents", "Resources", "glitter-harness", "cli.js");
for (const [path, what] of [[node, "Node runtime"], [cli, "CLI"]]) {
  if (!existsSync(path)) {
    console.error(`The app's ${what} is missing at ${path}. Install a current Glitter build first, or pass --app.`);
    process.exit(1);
  }
}
if (existsSync(launcher) && !owned()) {
  console.error(`${launcher} already exists and was not installed by Glitter. Remove it, or pass --bin with another folder.`);
  process.exit(1);
}

const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
mkdirSync(binDir, { recursive: true });
writeFileSync(launcher, `#!/bin/sh
${MARKER}
# Runs the CLI inside ${app} with the app's bundled Node.
exec ${quote(node)} ${quote(cli)} "$@"
`);
chmodSync(launcher, 0o755);
console.log(`Installed ${launcher}.`);
const onPath = (process.env.PATH ?? "").split(delimiter).some((dir) => resolve(dir) === binDir);
if (!onPath) console.log(`${binDir} is not on your PATH. Add it in your shell profile, for example:\n  export PATH="${binDir}:$PATH"`);
