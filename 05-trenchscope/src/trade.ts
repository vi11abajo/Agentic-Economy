// Sending the actual buy or sell through the Prosper router. Only reached with --execute, a key in .env,
// and a decision that just came out APE / EXIT on fresh data.
import { createWalletClient, decodeEventLog, defineChain, formatEther, http, parseEther, type Account, type Address, type Hash, type PublicClient } from "viem";
import { retry } from "./chain.js";
import { CHAIN_ID, ROUTER, RPC_URL, curveEvents, erc20Abi, routerAbi } from "./prosper.js";

const pharos = defineChain({
  id: CHAIN_ID,
  name: "Pharos Pacific Mainnet",
  nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
  rpcUrls: { default: { http: [process.env.TRENCHSCOPE_RPC || RPC_URL] } },
});

const GAS_RESERVE = parseEther("0.02"); // keep a little PROS for gas
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 300);

export interface Fill {
  hash: Hash;
  pros: number;
  tokens: number;
  block: number;
}

function fillFrom(receipt: { logs: { address: string; data: `0x${string}`; topics: [`0x${string}`, ...`0x${string}`[]] | [] }[]; blockNumber: bigint; transactionHash: Hash }, market: Address, me: Address): Fill {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== market.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: curveEvents, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
      const a = ev.args as unknown as Record<string, bigint | string>;
      if ((a.trader as string).toLowerCase() !== me.toLowerCase()) continue;
      const buy = ev.eventName === "Bought";
      return {
        hash: receipt.transactionHash,
        block: Number(receipt.blockNumber),
        pros: Number(formatEther((buy ? a.grossIn : a.netOut) as bigint)),
        tokens: Number(formatEther((buy ? a.pTokenOut : a.pTokenIn) as bigint)),
      };
    } catch {
      // other events in the same transaction
    }
  }
  throw new Error(`Transaction ${receipt.transactionHash} went through but has no Bought/Sold event for you`);
}

export async function buy(client: PublicClient, account: Account, market: Address, pros: number, minTokensOut: bigint): Promise<Fill> {
  const value = parseEther(String(pros));
  const balance = await retry(() => client.getBalance({ address: account.address }));
  if (balance < value + GAS_RESERVE) throw new Error(`Not enough PROS: wallet has ${formatEther(balance)}, needs ${pros} + gas`);
  const wallet = createWalletClient({ account, chain: pharos, transport: http() });
  const { request } = await client.simulateContract({ account, address: ROUTER, abi: routerAbi, functionName: "buyInnerNative", args: [market, minTokensOut, deadline()], value });
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`Buy reverted: ${hash}`);
  return fillFrom(receipt as never, market, account.address);
}

export async function sell(client: PublicClient, account: Account, market: Address, token: Address, tokens: bigint, minProsOut: bigint): Promise<Fill & { approveHash?: Hash }> {
  const wallet = createWalletClient({ account, chain: pharos, transport: http() });
  let approveHash: Hash | undefined;
  const allowance = await retry(() => client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, ROUTER] }));
  if (allowance < tokens) {
    approveHash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [ROUTER, tokens] });
    const r = await client.waitForTransactionReceipt({ hash: approveHash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`Approve reverted: ${approveHash}`);
  }
  const { request } = await client.simulateContract({ account, address: ROUTER, abi: routerAbi, functionName: "sellInner", args: [market, tokens, minProsOut, deadline(), true] });
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`Sell reverted: ${hash}`);
  return { ...fillFrom(receipt as never, market, account.address), approveHash };
}
