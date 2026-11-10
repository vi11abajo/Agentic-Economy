// Bundles the rapsheet CLI into one file inside the skill, so `npx skills add` gets something that runs with plain
// node: no npm install on the user's side.
import { existsSync } from "node:fs";
import { build } from "esbuild";

if (!existsSync("dist/cli.js")) process.exit(0);

await build({
  entryPoints: ["dist/cli.js"],
  outfile: "skill/rapsheet/scripts/rapsheet.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  banner: { js: "// rapsheet, built from 25-rapsheet/src in github.com/vi11abajo/Agentic-Economy (npm run build)" },
  logLevel: "warning",
});
