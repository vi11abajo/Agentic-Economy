// A tiny wallet world for the tests: an explorer index, receipts and balances per block that we control, so every
// category, the tie-out and the "worth a second look" rules can be checked without the network.
import type { Chain, Log, Receipt } from "./chain.js";
import type { Explorer, ExplorerInternal, ExplorerTransfer, ExplorerTx, Hex, History } from "./explorer.js";
import { TOPIC } from "./ledger.js";

export const ME = "0x00000000000000000000000000000000000000aa" as Hex;
export const ALICE = "0x00000000000000000000000000000000000000a1" as Hex;
export const BOB = "0x00000000000000000000000000000000000000b0" as Hex;
export const USDC = "0x00000000000000000000000000000000000000c0" as Hex;
export const TACO = "0x00000000000000000000000000000000000000c1" as Hex;
export const ROUTER = "0x00000000000000000000000000000000000000d0" as Hex;
export const VAULT = "0x00000000000000000000000000000000000000d1" as Hex;
export const POOL = "0x00000000000000000000000000000000000000d2" as Hex;

export const word = (a: string) => ("0x" + a.slice(2).padStart(64, "0")) as Hex;
export const amountData = (v: bigint) => ("0x" + v.toString(16).padStart(64, "0")) as Hex;
export const transferLog = (token: Hex, from: Hex, to: Hex, v: bigint): Log => ({ address: token, topics: [TOPIC.transfer, word(from), word(to)], data: amountData(v) });
export const approvalLog = (token: Hex, owner: Hex, spender: Hex, v: bigint): Log => ({ address: token, topics: [TOPIC.approval, word(owner), word(spender)], data: amountData(v) });
export const swapLog = (pool: Hex): Log => ({ address: pool, topics: [TOPIC.swapV3, word(ROUTER), word(ME)], data: "0x" });

export const hashOf = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;

/** Blocks are one second apart and block n has timestamp T0 + n. */
export const T0 = 1_700_000_000;

export class FakeWorld {
  txs: ExplorerTx[] = [];
  transfers: ExplorerTransfer[] = [];
  internals: ExplorerInternal[] = [];
  receiptsByHash = new Map<Hex, Receipt>();
  contracts = new Set<string>([USDC, TACO, ROUTER, VAULT, POOL]);
  names = new Map<string, string>([
    [ROUTER, "Router"],
    [VAULT, "Vault"],
    [USDC, "USDC"],
  ]);
  /** balance changes: asset -> list of [block, delta]; state at block n = sum of deltas at blocks <= n */
  deltas = new Map<string, [number, bigint][]>();
  allowances = new Map<string, bigint>();
  head = 1000;
  cut = false;

  move(asset: string, block: number, delta: bigint) {
    this.deltas.set(asset, [...(this.deltas.get(asset) ?? []), [block, delta]]);
  }

  /** Adds a transaction: explorer rows plus the receipt, and moves the balances its logs and value imply. */
  add(o: {
    n: number;
    block: number;
    from?: Hex;
    to: Hex;
    value?: string;
    method?: string;
    methodId?: string;
    ok?: boolean;
    fee?: bigint;
    logs?: Log[];
    internals?: { from: Hex; to: Hex; value: string }[];
    /** false when the explorer lists this tx only through its token transfers (someone else sent it) */
    listed?: boolean;
  }) {
    const hash = hashOf(o.n);
    const from = o.from ?? ME;
    const ok = o.ok ?? true;
    const fee = o.fee ?? 1000n;
    const time = T0 + o.block;
    if (o.listed ?? true)
      this.txs.push({ hash, from, to: o.to, value: o.value ?? "0", methodId: o.methodId ?? "0x12345678", method: o.method ?? "", block: o.block, time, ok });
    const logs = ok ? o.logs ?? [] : [];
    for (const l of logs) {
      if (l.topics[0] !== TOPIC.transfer) continue;
      const f = ("0x" + l.topics[1].slice(26)) as Hex;
      const t = ("0x" + l.topics[2].slice(26)) as Hex;
      const v = BigInt(l.data);
      this.transfers.push({ hash, token: l.address, from: f, to: t, block: o.block, time, symbol: l.address === USDC ? "USDC" : "TACO", name: "", decimals: 6, standard: "ERC20" });
      if (f === ME) this.move(l.address, o.block, -v);
      if (t === ME) this.move(l.address, o.block, v);
    }
    for (const i of o.internals ?? []) {
      this.internals.push({ hash, from: i.from, to: i.to, value: i.value, block: o.block, time, ok });
      const wei = BigInt(Math.round(Number(i.value) * 1e6)) * 10n ** 12n;
      if (ok && i.from === ME) this.move("native", o.block, -wei);
      if (ok && i.to === ME) this.move("native", o.block, wei);
    }
    const wei = BigInt(Math.round(Number(o.value ?? "0") * 1e6)) * 10n ** 12n;
    if (ok && from === ME) this.move("native", o.block, -wei);
    if (ok && o.to === ME) this.move("native", o.block, wei);
    if (from === ME) this.move("native", o.block, -fee);
    this.receiptsByHash.set(hash, { hash, ok, from, to: o.to, fee, logs });
    return hash;
  }

  balanceAt(asset: string, block: bigint): bigint {
    return (this.deltas.get(asset) ?? []).filter(([b]) => BigInt(b) <= block).reduce((s, [, d]) => s + d, 0n);
  }

  history(): History {
    return { txs: this.txs, transfers: this.transfers, internals: this.internals, names: this.names, contracts: this.contracts, cut: this.cut };
  }

  explorer(): Explorer {
    return {
      history: async (_w, until) => {
        const h = this.history();
        return { ...h, txs: h.txs.filter((t) => t.block <= until), transfers: h.transfers.filter((t) => t.block <= until), internals: h.internals.filter((t) => t.block <= until) };
      },
    };
  }

  chain(): Chain {
    return {
      head: async () => BigInt(this.head),
      blockTime: async (n) => T0 + Number(n),
      receipts: async (hashes) => new Map(hashes.filter((h) => this.receiptsByHash.has(h)).map((h) => [h, this.receiptsByHash.get(h)!])),
      nativeBalance: async (_who, block) => this.balanceAt("native", block),
      tokenBalance: async (token, _who, block) => this.balanceAt(token, block),
      allowance: async (token, _owner, spender) => this.allowances.get(`${token}:${spender}`) ?? 0n,
      tokenInfo: async (token) => ({ symbol: token === USDC ? "USDC" : "TACO", decimals: 6 }),
    };
  }
}
