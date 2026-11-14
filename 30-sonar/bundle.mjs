import { existsSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

if (!existsSync("dist/src/cli.js")) process.exit(0);
mkdirSync("skill/sonar/scripts", { recursive: true });

await build({
  entryPoints: ["dist/src/cli.js"],
  outfile: "skill/sonar/scripts/sonar.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  banner: { js: "// sonar, built from 30-sonar/src in github.com/vi11abajo/Agentic-Economy (npm run build)" },
  logLevel: "warning",
});
