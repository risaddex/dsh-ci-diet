#!/usr/bin/env bun
// Bundle the CLI (named cli.mjs: the entry guard in src/cli/index.ts matches that name) into one self-contained file for the Claude Code / Codex plugin.
// validate.ts loads ajv through createRequire, which a bundler cannot follow, so
// this build swaps those two lines for static imports (source stays untouched).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, process.argv[2] ?? "plugin/bin");

const result = await Bun.build({
  entrypoints: [resolve(root, "src/cli/index.ts")],
  target: "node",
  format: "esm",
  outdir,
  naming: "cli.mjs",
  plugins: [{
    name: "static-ajv",
    setup(build) {
      build.onLoad({ filter: /contracts[\\/]validate\.ts$/ }, ({ path }) => {
        let text = readFileSync(path, "utf8");
        const before = text;
        text = text
          .replace('import { createRequire } from "node:module";', 'import ajv2020Mod from "ajv/dist/2020.js";\nimport addFormatsMod from "ajv-formats";')
          .replace(/const require = createRequire\([^\n]*\n/, "")
          .replace('require("ajv/dist/2020") as', "ajv2020Mod as unknown as")
          .replace('require("ajv-formats") as FormatsInstall', "addFormatsMod as unknown as FormatsInstall");
        if (text === before || /createRequire\(|\brequire\(/.test(text)) throw new Error("validate.ts changed upstream; update scripts/bundle-plugin.mjs");
        return { contents: text, loader: "ts" };
      });
    },
  }],
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
console.log("bundled " + resolve(outdir, "cli.mjs"));
