// What turnstile sells. The paywall runs on Atlantic (that's where the test USDC is), but the goods are live reads
// of Pharos mainnet, so a buyer pays testnet cents for something real. Each call reads the chain at that moment;
// nothing is cached or made up.
import { createPublicClient, formatGwei, formatUnits, http, parseAbiItem, type Hex } from "viem";

const MAINNET_RPC = process.env.PHAROS_RPC || "https://rpc.pharos.xyz";
const MAINNET_USDC: Hex = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const MAINNET_TX = (h: string) => `https://www.pharosscan.xyz/tx/${h}`;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO = "0x0000000000000000000000000000000000000000";

const mainnet = createPublicClient({ transport: http(MAINNET_RPC, { timeout: 20_000, retryCount: 2 }) });

/** /v1/pulse: how busy Pharos mainnet is right now, from the last 20 blocks. */
export async function pulse() {
  const head = await mainnet.getBlock();
  const [older, fees, price] = await Promise.all([
    mainnet.getBlock({ blockNumber: head.number - 19n }),
    mainnet.getFeeHistory({ blockCount: 20, rewardPercentiles: [50] }),
    mainnet.getGasPrice(),
  ]);
  const seconds = Number(head.timestamp - older.timestamp);
  const used = fees.gasUsedRatio.reduce((a, b) => a + b, 0) / fees.gasUsedRatio.length;
  return {
    network: "Pharos mainnet (1672)",
    block: head.number.toString(),
    blockTime: new Date(Number(head.timestamp) * 1000).toISOString(),
    txsInLastBlock: head.transactions.length,
    secondsPerBlock: +(seconds / 19).toFixed(3),
    gasPriceGwei: formatGwei(price),
    baseFeeGwei: formatGwei(head.baseFeePerGas ?? 0n),
    blockFullness: `${(used * 100).toFixed(2)}% of the gas limit, average of the last 20 blocks`,
  };
}

/** /v1/usdc-flows: every USDC transfer on mainnet in the last 1000 blocks (the RPC's getLogs limit). */
export async function usdcFlows() {
  const head = await mainnet.getBlockNumber();
  const logs = await mainnet.getLogs({ address: MAINNET_USDC, event: TRANSFER, fromBlock: head - 999n, toBlock: head });
  let volume = 0n;
  let minted = 0n;
  let burned = 0n;
  for (const l of logs) {
    const v = l.args.value ?? 0n;
    if (l.args.from === ZERO) minted += v;
    else if (l.args.to === ZERO) burned += v;
    else volume += v;
  }
  const biggest = [...logs]
    .filter((l) => l.args.from !== ZERO && l.args.to !== ZERO)
    .sort((a, b) => (b.args.value! > a.args.value! ? 1 : b.args.value! < a.args.value! ? -1 : 0))
    .slice(0, 5)
    .map((l) => ({ usdc: formatUnits(l.args.value!, 6), from: l.args.from, to: l.args.to, block: l.blockNumber.toString(), tx: MAINNET_TX(l.transactionHash) }));
  return {
    network: "Pharos mainnet (1672)",
    window: { fromBlock: (head - 999n).toString(), toBlock: head.toString() },
    transfers: logs.length,
    volumeUsdc: formatUnits(volume, 6),
    mintedUsdc: formatUnits(minted, 6),
    burnedUsdc: formatUnits(burned, 6),
    biggest,
  };
}
