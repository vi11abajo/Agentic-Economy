#!/usr/bin/env node
// dent look  --wallet 0x.. --lane USDC|PROS [--from <place>] [--amount N] [--hold-days 30] [--min-gain 0.01] [--keep-pros 0.005] [--json file] [--plan file]
// dent sign  <plan.json> [--port 8642]
// dent places
import { writeFileSync } from "node:fs";
import { RpcChain } from "./chain.js";
import { backtest, renderBacktest } from "./backtest.js";
import { look } from "./look.js";
import { render } from "./render.js";
import { serveSigning } from "./sign.js";
import { SOURCES, type Lane } from "./venues.js";

function flags(argv: string[]) {
  const out: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = "1";
    else if (a.startsWith("--")) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
      i++;
    } else rest.push(a);
  }
  return { out, rest };
}

const HELP = `dent: compares Pharos yield venues by the rate you'd get once your money lands, counts gas, fees and
waiting, and says MOVE (with transactions for your own wallet) or STAY PUT (with the reason).

  dent places
  dent look --wallet 0x... --lane USDC|PROS [--from <place>] [--amount N] [--hold-days 30]
            [--min-gain 0.01] [--keep-pros 0.005] [--json look.json] [--plan plan.json]
  dent sign plan.json [--port 8642]     opens a local page; you sign in your own browser wallet
  dent backtest --lane USDC|PROS [--amount 100] [--start <place>] [--days 60] [--every 7] [--hold-days 30]
            [--min-gain X] [--json file]       replays the rule on the chain's history`;

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { out: f, rest } = flags(argv);
  if (!cmd || f.help || cmd === "help") return console.log(HELP);
  if (cmd === "places") {
    for (const s of SOURCES) console.log(`${s.id.padEnd(20)} ${s.lane.padEnd(5)} ${s.name}  (${s.protocol})${s.address ? "  " + s.address : ""}`);
    return;
  }
  if (cmd === "look") {
    if (!f.wallet || !/^0x[0-9a-fA-F]{40}$/.test(f.wallet)) throw new Error("--wallet 0x... is required");
    const lane = (f.lane ?? "USDC").toUpperCase() as Lane;
    if (lane !== "USDC" && lane !== "PROS") throw new Error("--lane is USDC or PROS");
    const chain = new RpcChain();
    const l = await look(chain, {
      wallet: f.wallet.toLowerCase(),
      lane,
      from: f.from,
      amount: f.amount,
      holdDays: Number(f["hold-days"] ?? 30),
      minGain: Number(f["min-gain"] ?? (lane === "USDC" ? 0.01 : 0.001)),
      keepPros: Number(f["keep-pros"] ?? 0.005),
    });
    console.log(render(l));
    console.log(`\n(${chain.requests} RPC requests to ${process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz"})`);
    const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
    if (f.json) writeFileSync(f.json, JSON.stringify(l, replacer, 2));
    if (f.plan) {
      if (l.plan) {
        writeFileSync(f.plan, JSON.stringify(l.plan, replacer, 2));
        console.log(`plan written to ${f.plan}; open it with: dent sign ${f.plan}`);
      } else console.log("no plan written: the answer is STAY PUT");
    }
    return;
  }
  if (cmd === "backtest") {
    const lane = (f.lane ?? "USDC").toUpperCase() as Lane;
    if (lane !== "USDC" && lane !== "PROS") throw new Error("--lane is USDC or PROS");
    const args = {
      lane,
      amount: f.amount ?? "100",
      start: f.start ?? (lane === "USDC" ? "wallet-usdc" : "wallet-pros"),
      days: Number(f.days ?? 60),
      every: Number(f.every ?? 7),
      holdDays: Number(f["hold-days"] ?? 30),
      minGain: Number(f["min-gain"] ?? (lane === "USDC" ? 0.01 : 0.001)),
      // An address that holds nothing anywhere, so every "your position" read is 0.
      wallet: "0x000000000000000000000000000000000000d3e7",
    };
    const chain = new RpcChain();
    const bt = await backtest(chain, args, (s) => process.stderr.write(s + "\n"));
    console.log(renderBacktest(bt, args));
    console.log(`\n(${chain.requests} RPC requests)`);
    if (f.json) writeFileSync(f.json, JSON.stringify(bt, null, 2));
    return;
  }
  if (cmd === "sign") {
    if (!rest[0]) throw new Error("dent sign <plan.json>");
    await serveSigning(new RpcChain(), rest[0], Number(f.port ?? 8642));
    return;
  }
  throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
}

main().catch((e) => {
  console.error(`dent: ${(e as Error).message}`);
  process.exit(1);
});
