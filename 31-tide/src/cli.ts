#!/usr/bin/env node
import { getAddress, isAddress, isHex, parseEther, type Address, type Hex } from "viem";
import { g, paid, past, sample, spark, stats } from "./gas.js";
import { loadAccount } from "./keys.js";
import { NETWORKS, reader, writer, type Network } from "./net.js";
import { hold, newJob, receiptText, type Deps } from "./run.js";
import { Store, homeDir } from "./store.js";

const HELP = `tide: watches Pharos gas and holds a non-urgent tx until it is cheap, never past its deadline

  tide now                         gas right now and what the last txs really paid
  tide history [--hours 24]        base fee over time, from the chain and from tide's own readings
  tide watch [--every 15]          keep taking readings (they feed the history)
  tide send --to <address> [--value <PROS>] [--data 0x…] --deadline <20m|2h|ISO time> [--max-gwei <n>]
            --key-env <file>       hold the tx, send it, print the receipt next to the price at request time
            --dry-run --from <address>   same, but stop where it would send (no key needed)
  tide resume --key-env <file>     carry on with jobs that were holding or waiting for a receipt
  tide jobs                        every job and how it ended

  --network mainnet|atlantic (default mainnet)   --home <dir> (default TIDE_HOME, or %APPDATA%\\tide / ~/.config/tide)

The key is read from PRIVATE_KEY in the env file you point at. tide only prints the address.`;

const argv = process.argv.slice(2);
const opt = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const valued = ["--hours", "--every", "--to", "--value", "--data", "--deadline", "--max-gwei", "--key-env", "--from", "--network", "--home"];
const command = argv.find((a, i) => !a.startsWith("--") && !valued.includes(argv[i - 1]));
const net: Network = NETWORKS[(opt("--network") ?? "mainnet") as Network["name"]];
const store = new Store(opt("--home") ?? homeDir());
const stamp = () => new Date().toISOString().slice(11, 19);

function deadlineOf(v: string | undefined, now = new Date()): Date {
  if (!v) throw new Error("--deadline is required, like 20m, 2h or an ISO time");
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(s|m|h)$/);
  const d = m ? new Date(now.getTime() + Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"]) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`can't read --deadline ${v}`);
  if (d <= now) throw new Error(`--deadline ${v} is already in the past`);
  return d;
}

function deps(wallet: Deps["wallet"]): Deps {
  return {
    client: reader(net),
    wallet,
    net,
    store,
    say: (l) => console.log(`[${stamp()}] ${l}`),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    checkSeconds: 5,
  };
}

const key = () => {
  const file = opt("--key-env");
  const a = loadAccount(["PRIVATE_KEY"], file);
  if (!a) throw new Error(`no PRIVATE_KEY ${file ? `in ${file}` : "in the environment"}; pass --key-env <file>, or --dry-run --from <address>`);
  return a;
};

async function main(): Promise<number> {
  if (!command || argv.includes("--help") || argv.includes("-h")) return console.log(HELP), 0;
  if (!net) throw new Error(`--network must be mainnet or atlantic`);
  const c = reader(net);

  if (command === "now") {
    const s = await sample(c, net);
    store.record(s);
    const p = await paid(c, 30);
    console.log(`Pharos ${net.name}, block ${s.block}`);
    console.log(`  base fee     ${g(s.base)}   (what every tx pays at least)`);
    console.log(`  eth_gasPrice ${g(s.gasPrice)}   (what a wallet that asks the node offers)`);
    console.log(`  tips lately  p10 ${s.tips.p10} · p50 ${s.tips.p50} · p90 ${s.tips.p90} gwei over the last 20 blocks with txs`);
    if (p.length) {
      const over = p.filter((x) => x > s.base + 1e-9).length;
      const st = stats(p);
      console.log(`  last ${p.length} txs paid ${g(st.min)} to ${g(st.max)}, median ${g(st.median)}; ${over} paid more than the base fee`);
    }
    return 0;
  }

  if (command === "history") {
    const hours = Number(opt("--hours") ?? 24);
    const chain = await past(c, net, hours, 48);
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const own = store.samples(net.name, since);
    const st = stats(chain.map((p) => p.base));
    console.log(`Pharos ${net.name}, base fee over the last ${hours} h (${chain.length} blocks spread evenly, ${chain[0].at.slice(0, 16)} to ${chain.at(-1)!.at.slice(0, 16)} UTC)`);
    console.log(`  ${spark(chain.map((p) => p.base))}`);
    console.log(`  min ${g(st.min)} · median ${g(st.median)} · max ${g(st.max)}`);
    for (const p of chain.filter((_, i) => i % 8 === 0 || i === chain.length - 1)) console.log(`  ${p.at.slice(0, 16).replace("T", " ")}  block ${p.block.padStart(9)}  ${g(p.base)}`);
    if (own.length) {
      const o = stats(own.map((s) => s.base));
      console.log(`tide's own readings in that time: ${own.length}, base ${g(o.min)} to ${g(o.max)}, eth_gasPrice ${g(stats(own.map((s) => s.gasPrice)).median)} (median)`);
      console.log(`  ${spark(own.slice(-60).map((s) => s.base))}  last ${Math.min(60, own.length)}`);
    } else console.log(`tide has no readings of its own yet: run tide watch, or they come with every tide send`);
    return 0;
  }

  if (command === "watch") {
    const every = Math.max(3, Number(opt("--every") ?? 15));
    console.log(`reading Pharos ${net.name} gas every ${every} s, Ctrl+C to stop`);
    for (;;) {
      try {
        const s = await sample(c, net);
        store.record(s);
        console.log(`[${stamp()}] block ${s.block}  base ${g(s.base)}  eth_gasPrice ${g(s.gasPrice)}  tips p10/p50/p90 ${s.tips.p10}/${s.tips.p50}/${s.tips.p90}`);
      } catch (e) {
        console.log(`[${stamp()}] reading failed: ${(e as Error).message.split("\n")[0]}`);
      }
      await new Promise((r) => setTimeout(r, every * 1000));
    }
  }

  if (command === "send") {
    const to = opt("--to");
    if (!to || !isAddress(to, { strict: false })) throw new Error(`--to needs an address`);
    const data = opt("--data") as Hex | undefined;
    if (data && !isHex(data)) throw new Error(`--data must be 0x hex`);
    const line = opt("--max-gwei") === undefined ? undefined : Number(opt("--max-gwei"));
    if (line !== undefined && !(line >= 0)) throw new Error(`--max-gwei must be a number`);
    let wallet: Deps["wallet"];
    let from: Address;
    if (argv.includes("--dry-run")) {
      const f = opt("--from");
      if (!f || !isAddress(f, { strict: false })) throw new Error(`--dry-run needs --from <address> to estimate gas for`);
      from = getAddress(f.toLowerCase());
    } else {
      const a = key();
      wallet = writer(net, a);
      from = a.address;
    }
    const d = deps(wallet);
    console.log(`tide on Pharos ${net.name}, from ${from}${wallet ? "" : " (dry run)"}`);
    const job = await newJob(d, { from, to: getAddress(to.toLowerCase()), value: parseEther(opt("--value") ?? "0"), data, deadline: deadlineOf(opt("--deadline")), line, hours: Number(opt("--hours") ?? 24) });
    const done = await hold(d, job);
    console.log(`\n${receiptText(done, net)}`);
    return done.status === "mined" || done.status === "would-send" ? 0 : 2;
  }

  if (command === "resume") {
    const open = store.jobs().filter((j) => j.network === net.name && (j.status === "holding" || j.status === "sent"));
    if (!open.length) return console.log(`no open jobs on ${net.name}`), 0;
    const a = key();
    const d = deps(writer(net, a));
    for (const j of open) {
      if (j.from.toLowerCase() !== a.address.toLowerCase()) {
        console.log(`job ${j.id} is from ${j.from}, the key is for ${a.address}: skipped`);
        continue;
      }
      console.log(`job ${j.id}: ${j.status}, deadline ${j.deadline}`);
      console.log(receiptText(await hold(d, j), net));
    }
    return 0;
  }

  if (command === "jobs") {
    const all = store.jobs();
    if (!all.length) console.log(`no jobs yet (${store.dir})`);
    for (const j of all) console.log(`${j.id}  ${j.network}  ${j.status.padEnd(10)}  to ${j.tx.to}  deadline ${j.deadline}${j.hash ? `  ${j.hash}` : ""}`);
    return 0;
  }

  console.error(`unknown command '${command}'\n\n${HELP}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`tide: ${(e as Error).message.split("\n")[0]}`);
    process.exit(1);
  },
);
