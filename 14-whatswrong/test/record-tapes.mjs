// Runs the real investigation on each example and writes down every chain answer (a "tape"), so the tests can
// replay these exact cases offline. Run by hand after `npm run build`: node test/record-tapes.mjs [name]
import { readFileSync, writeFileSync } from "node:fs";
import { performAutopsy } from "../dist/autopsy.js";
import { PharosMcp } from "../dist/mcp.js";
import { proveTheFix } from "../dist/remedy.js";
import { onChainWitness, taped } from "../dist/witness.js";

const only = process.argv[2];
const scenes = ["prosper-slippage", "prosper-out-of-gas", "prosper-no-allowance", "faroswap-too-little", "faroswap-same-block", "faroswap-stf", "faroswap-too-old", "harbor-vault-dry", "harbor-deposit-short"];
const mcp = new PharosMcp("whatswrong-tapes");
await mcp.connect();
for (const name of scenes.filter((s) => !only || s === only)) {
  const { hash } = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
  const tape = {};
  const witness = taped(onChainWitness(mcp), tape);
  const autopsy = await performAutopsy(witness, hash);
  const remedy = await proveTheFix(witness, autopsy);
  writeFileSync(new URL(`./tapes/${name}.json`, import.meta.url), JSON.stringify({ hash, tape }, null, 1));
  const big = (_, v) => (typeof v === "bigint" ? v.toString() : v);
  console.log(name, "->", autopsy.kind, "| said", autopsy.said.name, autopsy.said.message ?? "", "| deepest", autopsy.deepest?.name ?? "-", autopsy.deepest?.message ?? "");
  console.log("   facts", JSON.stringify(autopsy.facts, big).slice(0, 300));
  console.log("   now", remedy.wouldPassNow, "check", JSON.stringify(remedy.check, big)?.slice(0, 300), remedy.notes.join("; "));
}
await mcp.close();
