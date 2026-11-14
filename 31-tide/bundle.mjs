import { existsSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

if (!existsSync("dist/src/cli.js")) process.exit(0);
mkdirSync("skill/tide/scripts", { recursive: true });

await build({
  entryPoints: ["dist/src/cli.js"],
  outfile: "skill/tide/scripts/tide.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  banner: { js: "// tide, built from 31-tide/src in github.com/vi11abajo/Agentic-Economy (npm run build)" },
  logLevel: "warning",
});
