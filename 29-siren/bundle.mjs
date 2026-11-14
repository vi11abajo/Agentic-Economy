import { existsSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

if (!existsSync("dist/src/cli.js")) process.exit(0);
mkdirSync("skill/siren/scripts", { recursive: true });

await build({
  entryPoints: ["dist/src/cli.js"],
  outfile: "skill/siren/scripts/siren.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  banner: { js: "// siren, built from 29-siren/src in github.com/vi11abajo/Agentic-Economy (npm run build)" },
  logLevel: "warning",
});
