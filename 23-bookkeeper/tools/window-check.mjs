// Asks the real Pharos USDC, with eth_call only (nothing is sent, no money moves), what it says about a bookkeeper
// payment signed by a throwaway key: inside its window, before it, and after it. The balance comes from a state
// override (USDC keeps balances in storage slot 9).
import { createPublicClient, encodeAbiParameters, http, keccak256, pad, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PHAROS_RPC, USDC } from "../dist/chain.js";
import { paymentNonce, usdcCall } from "../dist/pay.js";

const c = createPublicClient({ transport: http(PHAROS_RPC) });
const agent = privateKeyToAccount(generatePrivateKey());
const payee = "0x000000000000000000000000000000000000dEaD";
const block = await c.getBlock();
const now = block.timestamp;
const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [agent.address, 9n]));
const funded = [{ address: USDC, stateDiff: [{ slot, value: pad(toHex(1_000_000n)) }] }];
const nonce = paymentNonce(agent.address, "window-check", 0, 0);
console.log(`Pharos block ${block.number}, timestamp ${now}; throwaway wallet ${agent.address}, 1 USDC by state override`);
for (const [label, after, before, override] of [
  ["window open (due a minute ago, next due in a week)", now - 60n, now + 604800n, funded],
  ["window not open yet (due tomorrow)", now + 86400n, now + 2n * 86400n, funded],
  ["window closed (period ended a minute ago)", now - 604800n, now - 60n, funded],
  ["window open, wallet empty", now - 60n, now + 604800n, undefined],
]) {
  const data = await usdcCall(agent, payee, 10_000n, after, before, nonce);
  try {
    await c.call({ account: agent.address, to: USDC, data, stateOverride: override });
    console.log(`${label}: goes through`);
  } catch (e) {
    console.log(`${label}: refused - ${(e.details || e.shortMessage).split("\n")[0]}`);
  }
}
