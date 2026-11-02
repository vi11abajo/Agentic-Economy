// Bundles the CLI into one file inside the skill, so `npx skills add` gets something that runs with plain
// node: no npm install on the user's side.
import { build } from "esbuild";

await build({
  entryPoints: ["dist/cli.js"],
  outfile: "skill/whatswrong/scripts/whatswrong.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  banner: { js: "// whatswrong, built from 14-whatswrong/src in github.com/vi11abajo/Agentic-Economy (npm run build)" },
  logLevel: "warning",
});
