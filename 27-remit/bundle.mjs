// Bundles the CLI into one standalone file inside the skill, so `npx skills add`
// gets something that runs with plain node: no npm install on the user's side.
import { existsSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

if (!existsSync("dist/src/cli.js")) process.exit(0);
mkdirSync("skill/remit/scripts", { recursive: true });

// pngjs is CommonJS and require()s node built-ins at runtime; an ESM bundle has no require of its own, so we hand it one.
const banner = [
  "// remit, built from 27-remit/src in github.com/vi11abajo/Agentic-Economy (npm run build)",
  'import { createRequire as __remitRequire } from "node:module"; const require = __remitRequire(import.meta.url);',
].join("\n");

await build({
  entryPoints: ["dist/src/cli.js"],
  outfile: "skill/remit/scripts/remit.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  banner: { js: banner },
  logLevel: "warning",
});
