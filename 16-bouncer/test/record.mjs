// Records real mainnet answers for the tests: four transactions the test wallet could ask bouncer about, each
// traced at one block, plus everything the gate would want to know about them (gas, balance, the code of every
// address the trace touched). Read-only: no key, nothing is sent. Run after `npm run build`:
//   node test/record.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { encodeFunctionData, maxUint256, parseAbi, parseEther } from "viem";
import { rpcChain, taped } from "../dist/chain.js";

const WALLET = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb";
const PMUSK_MARKET = "0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f";
const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const PROSPER_ROUTER = "0x63FfADf944583D8e4Fdc30144EFdfe3bdC2122f5";
const DEAD = "0x000000000000000000000000000000000000dEaD";

const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const buy = (pros) => ({
  from: WALLET,
  to: PMUSK_MARKET,
  value: parseEther(pros),
  data: encodeFunctionData({ abi: parseAbi(["function buyNative(uint256 minOut, uint256 deadline, address recipient) payable"]), functionName: "buyNative", args: [0n, deadline, WALLET] }),
});

const cases = {
  "pmusk-buy": buy("0.001"),
  "pros-send": { from: WALLET, to: DEAD, value: parseEther("0.001"), data: "0x" },
  "usdc-approve-max": { from: WALLET, to: USDC, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]), functionName: "approve", args: [PROSPER_ROUTER, maxUint256] }) },
  "too-big-buy": buy("1"),
};

const everyAddress = (f, out = new Set()) => {
  if (f.to) out.add(f.to.toLowerCase());
  for (const c of f.calls ?? []) everyAddress(c, out);
  return out;
};

const real = rpcChain();
mkdirSync(new URL("./tapes/", import.meta.url), { recursive: true });
for (const [name, tx] of Object.entries(cases)) {
  const tape = {};
  const chain = taped(real, tape);
  const block = (await chain.blockNumber()) - 1n;
  const note = [];
  let frame = null;
  try {
    frame = await chain.trace(tx, block);
  } catch (err) {
    note.push(`trace failed: ${err.message}`);
  }
  try {
    await chain.estimateGas(tx, block);
  } catch (err) {
    note.push(`estimateGas failed: ${err.message}`);
  }
  await chain.gasPrice();
  await chain.balance(WALLET, block);
  for (const a of frame ? everyAddress(frame) : [tx.to.toLowerCase()]) await chain.code(a, block);
  const request = { from: tx.from, to: tx.to, data: tx.data, value: tx.value.toString() };
  writeFileSync(new URL(`./tapes/${name}.json`, import.meta.url), JSON.stringify({ request, block: block.toString(), ...(note.length ? { note: note.join("; ") } : {}), tape }, null, 2) + "\n");
  console.log(`${name}: block ${block}${note.length ? `, ${note.join("; ")}` : ""}`);
}
