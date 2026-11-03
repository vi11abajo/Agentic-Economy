// Runs the real thing against Pharos mainnet and writes down every answer (a "tape"), so the tests can replay
// exactly these cases offline. Run by hand after `npm run build`: node test/record-tapes.mjs [scene]
import { writeFileSync } from "node:fs";
import { parseEther } from "viem";
import { rpcChain, taped } from "../dist/chain.js";
import { quoteCurve, quotePool, resolveVenue } from "../dist/market.js";
import { recentWallets } from "../dist/recipients.js";
import { check } from "../dist/check.js";
import { parsePlan } from "../dist/plan.js";
import { renderCheck } from "../dist/report.js";
import { SIM_KEY, nonceFor, probeSwap } from "../dist/testkit.js";

const WALLET = "0x4da5c63c10b505e638b5bf5226df15a1c8cb804a";
const now = BigInt(Math.floor(Date.now() / 1000));
// A check scene: saves the plan, the clock and the "what if" balances next to the tape, prints the report.
async function checkScene(chain, extra, raw, whatIf) {
  const parsed = parsePlan(raw); // the same road the CLI takes, addresses checksummed and all
  if (!parsed.plan) throw new Error(parsed.problems.join("; "));
  const plan = parsed.plan;
  Object.assign(extra, { plan, now, whatIf });
  console.log(renderCheck(await check(chain, plan, { now, simKey: SIM_KEY, nonceFor, whatIf })));
}
let airdropPlan;
async function airdrop(chain) {
  if (airdropPlan) return airdropPlan;
  const wallets = await recentWallets(rpcChain(), 10, { exclude: [WALLET] });
  airdropPlan = { wallet: WALLET, actions: wallets.map((w) => ({ kind: "send_usdc", to: w.address, amount: "0.00001" })) };
  return airdropPlan;
}
const buysPlan = { wallet: WALLET, actions: ["pTACO", "pCARR", "pMusk"].map((token) => ({ kind: "buy", token, pros: "5" })) };

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
  async recipients(chain, extra) {
    extra.exclude = ["0x4da5c63c10b505e638b5bf5226df15a1c8cb804a"];
    for (const w of await recentWallets(chain, 10, { exclude: extra.exclude })) console.log(w.address, w.block);
  },
  async airdrop(chain, extra) {
    await checkScene(chain, extra, await airdrop(chain), { pros: parseEther("1"), usdc: 1_000_000n });
  },
  async "airdrop-short"(chain, extra) {
    await checkScene(chain, extra, await airdrop(chain), { pros: parseEther("1"), usdc: 55n });
  },
  async buys(chain, extra) {
    await checkScene(chain, extra, buysPlan, { pros: parseEther("100") });
  },
  // The final review's critical case: WPROS credits whoever sends it PROS, and inside the batch that's Multicall3.
  async "pros-to-contract"(chain, extra) {
    await checkScene(chain, extra, { wallet: WALLET, actions: [{ kind: "send_pros", to: "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0", amount: "1" }] }, { pros: parseEther("10") });
  },
  async "buys-short"(chain, extra) {
    await checkScene(chain, extra, buysPlan, { pros: parseEther("10") });
  },
};

const only = process.argv[2];
for (const [name, scene] of Object.entries(scenes)) {
  if (only && only !== name) continue;
  const tape = {};
  const extra = {};
  await scene(taped(rpcChain(), tape), extra);
  writeFileSync(new URL(`./tapes/${name}.json`, import.meta.url), JSON.stringify({ ...extra, tape }, (_, v) => (typeof v === "bigint" ? `${v}n` : v), 1));
  console.log(name, "->", Object.keys(tape).length, "answers");
}
