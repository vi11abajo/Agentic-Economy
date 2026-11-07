// Bundles the CLI into one file inside the skill, so `npx skills add` gets something that runs with plain
// node: no npm install on the user's side.
import { existsSync } from "node:fs";
import { build } from "esbuild";

// Until the CLI exists there is nothing to bundle; the library modules still build and test fine.
if (!existsSync("dist/cli.js")) process.exit(0);

await build({
  entryPoints: ["dist/cli.js"],
  outfile: "skill/knock/scripts/knock.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  banner: { js: "// knock, built from 22-knock/src in github.com/vi11abajo/Agentic-Economy (npm run build)" },
  logLevel: "warning",
});
