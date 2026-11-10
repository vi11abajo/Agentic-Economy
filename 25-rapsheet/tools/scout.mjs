#!/usr/bin/env node
// scout: how the risky examples in proof/ were found, so anyone can find them (or newer ones) again.
// It sweeps the last N blocks of Pharos mainnet for two patterns and prints candidates to run rapsheet on:
//   1. plain wallets named as the spender in an ERC-20 Approval (apps take approvals through contracts)
//   2. proxies whose code was swapped (Upgraded event) more than a day after the proxy was created
// Read-only. Usage: node tools/scout.mjs [--blocks 100000]
const RPC = process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz";
const API = process.env.RAPSHEET_EXPLORER_API ?? "https://api.socialscan.io/pharos-mainnet/v1/explorer";
// topic hashes copied from real Pharos receipts, not typed by hand
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const UPGRADED = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";

const i = process.argv.indexOf("--blocks");
const BLOCKS = i > 0 ? Number(process.argv[i + 1]) : 100_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const d = await res.json();
      if (!d.error) return d.result;
    } catch {}
    await sleep(700 * attempt);
  }
  throw new Error(`${method} kept failing`);
}

async function profile(a) {
  const res = await fetch(`${API}/address/${a}/profile`);
  return res.ok ? res.json() : {};
}

async function sweep(topic, head) {
  const from = head - BLOCKS + 1;
  const spans = [];
  for (let b = from; b <= head; b += 1000) spans.push([b, Math.min(b + 999, head)]);
  const logs = [];
  for (let k = 0; k < spans.length; k += 4) {
    const got = await Promise.all(spans.slice(k, k + 4).map(([a, b]) => rpc("eth_getLogs", [{ fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}`, topics: [topic] }])));
    for (const g of got) logs.push(...g);
  }
  return logs;
}

const head = parseInt(await rpc("eth_blockNumber", []), 16);
console.log(`scout: last ${BLOCKS} blocks of Pharos mainnet, up to ${head}\n`);

const approvals = (await sweep(APPROVAL, head)).filter((l) => l.topics.length === 3);
const bySpender = new Map();
for (const l of approvals) {
  const s = `0x${l.topics[2].slice(-40)}`;
  const e = bySpender.get(s) ?? { owners: new Set(), last: l };
  e.owners.add(`0x${l.topics[1].slice(-40)}`);
  e.last = l;
  bySpender.set(s, e);
}
console.log(`${approvals.length} Approval events naming ${bySpender.size} spenders. Plain wallets among the spenders:`);
let wallets = 0;
for (const [s, e] of bySpender) {
  if ((await rpc("eth_getCode", [s, "latest"])) !== "0x") continue;
  wallets++;
  console.log(`  ${s}  approved by ${e.owners.size} owner(s), last in tx ${e.last.transactionHash}`);
}
if (!wallets) console.log("  none");

const upgrades = await sweep(UPGRADED, head);
console.log(`\n${upgrades.length} Upgraded events. Proxies upgraded more than a day after they were created:`);
let late = 0;
const seen = new Set();
for (const l of upgrades) {
  if (seen.has(l.address)) continue;
  seen.add(l.address);
  const p = await profile(l.address);
  if (!p.block_timestamp) continue;
  const block = await rpc("eth_getBlockByNumber", [l.blockNumber, false]);
  const gapDays = (parseInt(block.timestamp, 16) - Date.parse(p.block_timestamp) / 1000) / 86400;
  if (gapDays < 1) continue;
  late++;
  console.log(`  ${l.address}  created ${p.block_timestamp.slice(0, 10)}, upgraded ${gapDays.toFixed(1)} days later in tx ${l.transactionHash}${p.is_verified ? "" : " (unverified)"}`);
}
if (!late) console.log("  none");
console.log("\nThese are candidates, not verdicts: run rapsheet on each to see the full record.");
