// Everything the bookkeeper asks Pharos goes through this interface, so the payment logic can be tested against a
// fake chain and run against the real one without changes.
import { TransactionNotFoundError, TransactionReceiptNotFoundError, createPublicClient, getAddress, http, parseAbi, parseAbiItem, type Hex as VHex } from "viem";
import type { Hex } from "./store.js";

export const CHAIN_ID = 1672;
export const PHAROS_RPC = process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz";
export const USDC = getAddress("0xc879c018db60520f4355c26ed1a6d572cdac1815") as Hex;
export const EXPLORER_TX = "https://www.pharosscan.xyz/tx/";
// Pharos answers eth_getLogs for at most 1,000 blocks at a time.
const LOG_SPAN = 999n;

export const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);
const AUTH_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");

export interface Receipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
}

export interface Chain {
  usdcBalance(a: Hex): Promise<bigint>;
  prosBalance(a: Hex): Promise<bigint>;
  authorizationState(wallet: Hex, nonce: Hex): Promise<boolean>;
  /** The tx that used this authorization, searched from fromBlock to the head (null if not found). */
  findAuthorizationUsed(wallet: Hex, nonce: Hex, fromBlock: bigint): Promise<Hex | null>;
  /** Runs the tx as a call; the revert reason when it would fail, null when it would go through. */
  simulate(tx: { from: Hex; to: Hex; data?: Hex; value?: bigint }): Promise<string | null>;
  estimateGas(tx: { from: Hex; to: Hex; data?: Hex; value?: bigint }): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  pendingNonce(a: Hex): Promise<number>;
  /** Nonce of the account counting mined txs only. */
  latestNonce(a: Hex): Promise<number>;
  blockNumber(): Promise<bigint>;
  sendRaw(raw: Hex): Promise<Hex>;
  /** null while the node doesn't know the tx or it isn't mined yet. Throws when the node can't be asked. */
  receipt(hash: Hex): Promise<Receipt | null>;
  /** True when the node knows the tx at all (mined or still in the pool). Throws when the node can't be asked. */
  knowsTx(hash: Hex): Promise<boolean>;
}

const reason = (e: unknown) => {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  const text = err.details || err.shortMessage || err.message || String(e);
  return text.replace(/^Execution reverted with reason:\s*/i, "").replace(/^execution reverted:?\s*/i, "").split("\n")[0].trim();
};

export function viemChain(rpc = PHAROS_RPC): Chain {
  const c = createPublicClient({ transport: http(rpc, { retryCount: 3, retryDelay: 1500 }) });
  return {
    usdcBalance: (a) => c.readContract({ address: USDC, abi: USDC_ABI, functionName: "balanceOf", args: [a] }),
    prosBalance: (a) => c.getBalance({ address: a }),
    authorizationState: (w, n) => c.readContract({ address: USDC, abi: USDC_ABI, functionName: "authorizationState", args: [w, n] }),
    async findAuthorizationUsed(w, n, fromBlock) {
      const head = await c.getBlockNumber();
      for (let from = fromBlock; from <= head; from += LOG_SPAN + 1n) {
        const to = from + LOG_SPAN > head ? head : from + LOG_SPAN;
        const logs = await c.getLogs({ address: USDC, event: AUTH_USED, args: { authorizer: w, nonce: n }, fromBlock: from, toBlock: to });
        if (logs.length) return logs[0].transactionHash as Hex;
      }
      return null;
    },
    async simulate(tx) {
      try {
        await c.call({ account: tx.from, to: tx.to, data: tx.data as VHex | undefined, value: tx.value });
        return null;
      } catch (e) {
        return reason(e);
      }
    },
    estimateGas: (tx) => c.estimateGas({ account: tx.from, to: tx.to, data: tx.data as VHex | undefined, value: tx.value }),
    gasPrice: () => c.getGasPrice(),
    pendingNonce: (a) => c.getTransactionCount({ address: a, blockTag: "pending" }),
    latestNonce: (a) => c.getTransactionCount({ address: a, blockTag: "latest" }),
    blockNumber: () => c.getBlockNumber(),
    sendRaw: (raw) => c.sendRawTransaction({ serializedTransaction: raw }) as Promise<Hex>,
    async receipt(hash) {
      try {
        const r = await c.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed };
      } catch (e) {
        // "not found" is an answer; a timeout or a 429 is not, and must not be read as one
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
    async knowsTx(hash) {
      try {
        await c.getTransaction({ hash });
        return true;
      } catch (e) {
        if (e instanceof TransactionNotFoundError) return false;
        throw e;
      }
    },
  };
}
