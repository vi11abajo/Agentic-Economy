// A small pretend Pharos for the flow tests: blocks tick forward as you look at them, signed transactions really
// get decoded and applied, USDC transfers leave Transfer logs. Test-only; the CLI never imports it.
import {
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  pad,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { RevertedCall, type Chain, type CallLog, type Receipt, type RpcLog, type TxInfo } from "./chain.js";
import { PROSPER_V2_FACTORY, SWAP_TOPIC, WPROS } from "./buyers.js";

export const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815" as Address;
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
export const FAKE_PAIR = "0x00000000000000000000000000000000000000a1" as Address;
export const FAKE_TOKEN = "0x00000000000000000000000000000000000000b2" as Address;
const ROUTER = "0x00000000000000000000000000000000000000c3" as Address;

const erc20 = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const word = (v: bigint | Address) => (typeof v === "bigint" ? pad(toHex(v)) : pad(v));

export type FakeOptions = {
  head?: bigint;
  buyers?: Address[]; // newest first, one buy each, a few blocks apart
  contracts?: Address[];
  pros?: Record<Address, bigint>;
  usdc?: Record<Address, bigint>;
};

export class FakeChain implements Chain {
  journal: CallLog[] = [];
  head: bigint;
  pros = new Map<Address, bigint>();
  usdc = new Map<Address, bigint>();
  nonces = new Map<Address, number>();
  swaps: RpcLog[] = [];
  contracts: Set<Address>;
  mined = new Map<Hex, { tx: TxInfo; receipt: Receipt }>();
  sendCalls: Hex[] = [];
  /** Blocks that answer null the first time someone asks (a node behind the load balancer). */
  laggyBlocks = new Set<bigint>();
  /** USDC payouts to these addresses revert in simulation and on chain. */
  cursed = new Set<Address>();
  /** After this many successful sends, the next send is applied but the answer is "lost". */
  dropAnswerAfter = Infinity;
  /** After this many sends the "network" dies: every call throws until revive(). Simulates the process crashing. */
  killAfterSends = Infinity;
  private dead = false;

  revive() {
    this.dead = false;
    this.killAfterSends = Infinity;
  }

  private alive() {
    if (this.dead) throw new Error("socket hang up");
  }

  constructor(o: FakeOptions = {}) {
    this.head = o.head ?? 10_000n;
    this.contracts = new Set(o.contracts ?? []);
    for (const [a, v] of Object.entries(o.pros ?? {})) this.pros.set(a.toLowerCase() as Address, v);
    for (const [a, v] of Object.entries(o.usdc ?? {})) this.usdc.set(a.toLowerCase() as Address, v);
    (o.buyers ?? []).forEach((b, i) => {
      this.swaps.push({
        address: FAKE_PAIR,
        topics: [SWAP_TOPIC, pad(ROUTER), pad(b)],
        data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [5n, 0n, 0n, 7n]),
        blockNumber: this.head - 3n * BigInt(i + 1),
        logIndex: 0,
        transactionHash: keccak256(toHex(`buy ${i}`)),
      });
    });
  }

  step() {}

  async blockNumber() {
    this.alive();
    return this.head++;
  }

  async call(to: Address, data: Hex): Promise<Hex> {
    this.alive();
    if (to === PROSPER_V2_FACTORY && data === "0x574f2ba3") return word(1n);
    if (to === PROSPER_V2_FACTORY && data.startsWith("0x1e3dd18b")) return word(FAKE_PAIR);
    if (to === FAKE_PAIR && data === "0x0dfe1681") return word(WPROS);
    if (to === FAKE_PAIR && data === "0xd21220a7") return word(FAKE_TOKEN);
    if (to === USDC && data.startsWith("0x70a08231")) return word(this.usdc.get(`0x${data.slice(-40)}` as Address) ?? 0n);
    throw new Error(`fake chain has no answer for call ${to} ${data.slice(0, 10)}`);
  }

  async logs(q: { address: Address[] | Address; topics: (Hex | Hex[] | null)[]; from: bigint; to: bigint }) {
    this.alive();
    const all = [...this.swaps, ...[...this.mined.values()].flatMap((m) => m.receipt.logs)];
    const want = (Array.isArray(q.address) ? q.address : [q.address]).map((a) => a.toLowerCase());
    return all.filter(
      (l) =>
        want.includes(l.address) &&
        l.blockNumber >= q.from &&
        l.blockNumber <= q.to &&
        q.topics.every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]) : t === l.topics[i])),
    );
  }

  async code(a: Address) {
    this.alive();
    return (this.contracts.has(a.toLowerCase() as Address) ? "0x6080" : "0x") as Hex;
  }

  async balance(a: Address) {
    this.alive();
    return this.pros.get(a.toLowerCase() as Address) ?? 0n;
  }

  async block(n: bigint) {
    this.alive();
    if (n > this.head) return null;
    if (this.laggyBlocks.delete(n)) return null;
    return { number: n, hash: keccak256(toHex(`block ${n}`)) };
  }

  async nonce(a: Address) {
    this.alive();
    return this.nonces.get(a.toLowerCase() as Address) ?? 0;
  }

  async gasPrice() {
    this.alive();
    return 10_000_000_000n;
  }

  async estimateGas(tx: { from: Address; to: Address; data?: Hex; value?: bigint }) {
    this.alive();
    if (tx.to.toLowerCase() === USDC) {
      const { args } = decodeFunctionData({ abi: erc20, data: tx.data! });
      if (this.cursed.has(args[0].toLowerCase() as Address)) throw new RevertedCall("execution reverted: cursed");
      if ((this.usdc.get(tx.from.toLowerCase() as Address) ?? 0n) < args[1]) throw new RevertedCall("execution reverted: ERC20: transfer amount exceeds balance");
      return 79_757n;
    }
    return tx.data && tx.data !== "0x" ? 40_252n : 21_000n;
  }

  async sendRaw(raw: Hex): Promise<Hex> {
    this.alive();
    this.sendCalls.push(raw);
    const hash = keccak256(raw);
    if (this.mined.has(hash)) throw new Error("already known");
    const tx = parseTransaction(raw as TransactionSerialized);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })).toLowerCase() as Address;
    const to = tx.to!.toLowerCase() as Address;
    const value = tx.value ?? 0n;
    const gasCost = (tx.gas ?? 0n) * (tx.gasPrice ?? 0n);
    this.pros.set(from, (this.pros.get(from) ?? 0n) - gasCost - value);
    this.pros.set(to, (this.pros.get(to) ?? 0n) + value);
    this.nonces.set(from, (this.nonces.get(from) ?? 0) + 1);
    const logs: RpcLog[] = [];
    let status: Receipt["status"] = "success";
    if (to === USDC) {
      const { args } = decodeFunctionData({ abi: erc20, data: tx.data! });
      const dest = args[0].toLowerCase() as Address;
      if (this.cursed.has(dest)) status = "reverted";
      else {
        this.usdc.set(from, (this.usdc.get(from) ?? 0n) - args[1]);
        this.usdc.set(dest, (this.usdc.get(dest) ?? 0n) + args[1]);
        logs.push({ address: USDC, topics: [TRANSFER_TOPIC, pad(from), pad(dest)], data: pad(toHex(args[1])), blockNumber: this.head, logIndex: 0, transactionHash: hash });
      }
    }
    this.mined.set(hash, {
      tx: { hash, from, to, value, input: tx.data ?? "0x", blockNumber: this.head },
      receipt: { status, blockNumber: this.head, from, to, logs },
    });
    if (this.sendCalls.length >= this.killAfterSends) this.dead = true;
    if (this.sendCalls.length > this.dropAnswerAfter) {
      this.dropAnswerAfter = Infinity;
      throw new Error("fetch failed: the answer got lost on the way back");
    }
    return hash;
  }

  async receipt(h: Hex) {
    this.alive();
    return this.mined.get(h)?.receipt ?? null;
  }

  async transaction(h: Hex) {
    this.alive();
    return this.mined.get(h)?.tx ?? null;
  }

  usdcTransfersTo(a: Address) {
    return [...this.mined.values()].filter((m) => m.receipt.logs.some((l) => l.address === USDC && l.topics[2] === pad(a.toLowerCase() as Address))).length;
  }
}
