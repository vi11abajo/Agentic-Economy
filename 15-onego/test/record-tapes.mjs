// Runs the real thing against Pharos mainnet and writes down every answer (a "tape"), so the tests can replay
// exactly these cases offline. Run by hand after `npm run build`: node test/record-tapes.mjs [scene]
import { writeFileSync } from "node:fs";
import { parseEther } from "viem";
import { rpcChain, taped } from "../dist/chain.js";
import { quoteCurve, quotePool, resolveVenue } from "../dist/market.js";
import { probeSwap } from "../dist/testkit.js";

const FIVE = parseEther("5");
const scenes = {
  async quotes(chain) {
    const taco = await resolveVenue(chain, "pTACO");
    const out = quotePool(taco, FIVE);
    console.log("pTACO", out, (await probeSwap(chain, taco, FIVE, out)).ok, (await probeSwap(chain, taco, FIVE, (out * 1001n) / 1000n)).ok);
    const musk = await resolveVenue(chain, "pMusk");
    console.log("pMusk", musk.phase, await quoteCurve(chain, musk, FIVE));
    await resolveVenue(chain, "pNOPE").catch((e) => console.log("pNOPE", e.message));
  },
};

const only = process.argv[2];
for (const [name, scene] of Object.entries(scenes)) {
  if (only && only !== name) continue;
  const tape = {};
  await scene(taped(rpcChain(), tape));
  writeFileSync(new URL(`./tapes/${name}.json`, import.meta.url), JSON.stringify({ tape }, null, 1));
  console.log(name, "->", Object.keys(tape).length, "answers");
}
