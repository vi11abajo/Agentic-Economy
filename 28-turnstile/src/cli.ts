#!/usr/bin/env node
import type { AddressInfo } from "node:net";
import { formatEther, type Account } from "viem";
import { EIP3009, NETWORK, USDC, addressUrl, reader, usdc } from "./atlantic.js";
import { loadAccount } from "./keys.js";
import { makeFacilitator } from "./facilitator.js";
import { makeApp, CATALOG } from "./server.js";
import { buy, type Mode, type Purchase } from "./buyer.js";

const HELP = `turnstile: a pay-per-request API on Pharos Atlantic with x402, its own facilitator, and a buyer

  turnstile serve [--port 4028]          run the API + facilitator (seller key needed)
  turnstile buy <url> [--max 0.01] [--mode honest|underpay|forged]
                                         pay for one request, step by step (buyer key needed)
  turnstile demo                         serve on a free port and walk the whole flow, rejections included
  turnstile balances                     what the seller and buyer hold on Atlantic

Keys come from env files outside the repo, never from code or prompts:
  seller: SELLER_PRIVATE_KEY, in the environment or in the file --seller-env / TURNSTILE_SELLER_ENV
  buyer:  BUYER_PRIVATE_KEY or PRIVATE_KEY, in the environment or in --buyer-env / TURNSTILE_BUYER_ENV
The seller key receives the USDC and pays settlement gas (needs Atlantic PROS).
The buyer key only signs (needs Atlantic test USDC ${USDC}, no PROS).`;

const argv = process.argv.slice(2);
const opt = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const valueFlags = ["--port", "--max", "--mode", "--seller-env", "--buyer-env"];
const [command, target] = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(argv[i - 1]));

const seller = () => loadAccount(["SELLER_PRIVATE_KEY"], opt("--seller-env") ?? process.env.TURNSTILE_SELLER_ENV, true);
const buyer = () => loadAccount(["BUYER_PRIVATE_KEY", "PRIVATE_KEY"], opt("--buyer-env") ?? process.env.TURNSTILE_BUYER_ENV);
const need = (what: string) => {
  console.error(`no ${what} key found. ${what === "seller" ? "Set SELLER_PRIVATE_KEY or pass --seller-env <file>" : "Set BUYER_PRIVATE_KEY or pass --buyer-env <file>"} (see turnstile --help)`);
  return 2;
};
const cap = () => BigInt(Math.round(Number(opt("--max") ?? "0.01") * 1e6));

function show(p: Purchase): void {
  for (const s of p.steps) console.log(`  ${s.ok === undefined ? " " : s.ok ? "✓" : "✗"} ${s.say}`);
}

async function balances(sellerAcct: Account | null, buyerAcct: Account | null): Promise<void> {
  const chain = reader();
  for (const [who, a] of [["seller", sellerAcct], ["buyer", buyerAcct]] as const) {
    if (!a) continue;
    const [pros, u] = await Promise.all([chain.getBalance({ address: a.address }), chain.readContract({ address: USDC, abi: EIP3009, functionName: "balanceOf", args: [a.address] })]);
    console.log(`  ${who.padEnd(6)} ${a.address}  ${formatEther(pros)} PROS  ${usdc(u)} USDC  ${addressUrl(a.address)}`);
  }
}

async function main(): Promise<number> {
  if (!command || argv.includes("--help") || argv.includes("-h")) return console.log(HELP), 0;

  if (command === "balances") {
    const s = seller();
    const b = buyer();
    if (!s && !b) return need("seller");
    console.log(`Atlantic (${NETWORK}):`);
    await balances(s, b);
    return 0;
  }

  if (command === "serve") {
    const s = seller();
    if (!s) return need("seller");
    const { app, payTo } = makeApp(makeFacilitator(s));
    const port = Number(opt("--port") ?? 4028);
    app.listen(port, "127.0.0.1", () => {
      console.log(`turnstile on http://127.0.0.1:${port}  (${NETWORK}, paid to ${payTo})`);
      for (const c of CATALOG) console.log(`  GET ${c.path}  ${c.price} USDC  ${c.what}`);
      console.log(`  GET /health, /catalog  free\n  /facilitator/verify, /settle, /supported`);
    });
    return -1;
  }

  if (command === "buy") {
    if (!target) return console.error("turnstile buy <url>"), 1;
    const b = buyer();
    if (!b) return need("buyer");
    const p = await buy(target, { account: b, capAtomic: cap(), mode: (opt("--mode") as Mode) ?? "honest" });
    show(p);
    if (p.body !== undefined) console.log(JSON.stringify(p.body, null, 2));
    return p.status === 200 && p.settledOnChain !== false ? 0 : 2;
  }

  if (command === "demo") {
    const s = seller();
    const b = buyer();
    if (!s) return need("seller");
    if (!b) return need("buyer");
    const { app } = makeApp(makeFacilitator(s));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    console.log(`turnstile up at ${base} on ${NETWORK}\nbefore:`);
    await balances(s, b);

    console.log(`\n1. free route`);
    const health = await fetch(`${base}/health`);
    console.log(`  ✓ GET /health -> ${health.status} ${await health.text()}`);
    let failed = 0;
    for (const [n, path, mode] of [
      ["2", "/v1/pulse", "honest"],
      ["3", "/v1/usdc-flows", "honest"],
      ["4", "/v1/pulse", "underpay"],
      ["5", "/v1/pulse", "forged"],
    ] as const) {
      console.log(`\n${n}. ${mode === "honest" ? "pay for" : mode === "underpay" ? "try to underpay for" : "try a forged signature on"} ${path}`);
      const p = await buy(`${base}${path}`, { account: b, capAtomic: cap(), mode });
      show(p);
      if (mode === "honest" && p.body) console.log(`  data: ${JSON.stringify(p.body).slice(0, 400)}`);
      if ((mode === "honest") !== (p.status === 200 && p.settledOnChain === true)) failed++;
    }
    console.log(`\n6. the facilitator's own endpoint`);
    console.log(`  ✓ GET /facilitator/supported -> ${JSON.stringify(await (await fetch(`${base}/facilitator/supported`)).json())}`);
    console.log(`\nafter:`);
    await balances(s, b);
    server.close();
    return failed ? 2 : 0;
  }

  console.error(`unknown command '${command}'\n\n${HELP}`);
  return 1;
}

main().then(
  (code) => code >= 0 && process.exit(code),
  (e) => {
    console.error(`turnstile: ${(e as Error).message.split("\n")[0]}`);
    process.exit(1);
  },
);
