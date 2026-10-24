import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("playwright-core/package.json");
const packageRoot = dirname(packagePath);
const [packageJson, browsersJson] = await Promise.all([
  readFile(packagePath, "utf8").then(JSON.parse),
  readFile(join(packageRoot, "browsers.json"), "utf8").then(JSON.parse),
]);

/** ESM compatibility plus a module directory for Playwright's bundled code. */
export const STANDALONE_BANNER = `import { createRequire as __glitterCreateRequire } from "node:module";
import { fileURLToPath as __glitterFileURLToPath } from "node:url";
import { dirname as __glitterDirname } from "node:path";
const require = __glitterCreateRequire(import.meta.url);
const __dirname = __glitterDirname(__glitterFileURLToPath(import.meta.url));`;

/** Playwright normally reads these files from its npm package at runtime.
 * Glitter ships one verified bridge script, so pin their exact contents into
 * that script instead of recreating a node_modules layout in the app bundle.
 */
export const metadataPlugin = {
  name: "glitter-playwright-metadata",
  setup(build) {
    build.onLoad({ filter: /playwright-core[\\/]lib[\\/]coreBundle\.js$/ }, async (args) => {
      let contents = await readFile(args.path, "utf8");
      const replacements = [
        ['packageJSON = require(import_path8.default.join(packageRoot, "package.json"));', `packageJSON = ${JSON.stringify(packageJson)};`],
        ['registry = new Registry(require(import_path19.default.join(packageRoot, "browsers.json")));', `registry = new Registry(${JSON.stringify(browsersJson)});`],
      ];
      for (const [anchor, replacement] of replacements) {
        if (!contents.includes(anchor)) throw new Error(`Playwright metadata anchor changed: ${anchor}`);
        contents = contents.replace(anchor, replacement);
      }
      return { contents, loader: "js", resolveDir: dirname(args.path) };
    });
  },
};
