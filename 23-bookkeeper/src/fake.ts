// A small Pharos in memory for the tests: USDC with the same EIP-3009 rules the real token enforces (window,
// nonce used once, balance), PROS transfers, a mempool that can "lose" a tx, and switches to make sends fail.
import { decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, getAddress } from "viem";
import { USDC, USDC_ABI, type Chain, type Receipt } from "./chain.js";
import { AUTH_TYPES, USDC_DOMAIN } from "./pay.js";
import type { Hex } from "./store.js";

export class FakeChain implements Chain {
  time = 0n; // block timestamp, seconds
  block = 1000n;
  usdc = new Map<string, bigint>();
  pros = new Map<string, bigint>();
  used = new Map<string, Hex>(); // wallet:nonce -> tx hash
  receipts = new Map<Hex, Receipt>();
  pool = new Set<Hex>();
  sent: Hex[] = [];
  /** When set, sendRaw throws this before the node takes the tx. */
  refuse: string | null = null;
  /** When true, sendRaw takes the tx but the "response" is lost (throws after accepting). */
  dropResponse = false;
  /** When true, accepted txs stay in the pool until mine() is called. */
  holdInPool = false;

  setUsdc(a: Hex, v: bigint) {
    this.usdc.set(a.toLowerCase(), v);
  }
  setPros(a: Hex, v: bigint) {
    this.pros.set(a.toLowerCase(), v);
  }
  async usdcBalance(a: Hex) {
    return this.usdc.get(a.toLowerCase()) ?? 0n;
  }
  async prosBalance(a: Hex) {
    return this.pros.get(a.toLowerCase()) ?? 0n;
  }
  async authorizationState(w: Hex, n: Hex) {
    return this.used.has(`${w.toLowerCase()}:${n}`);
  }
  async findAuthorizationUsed(w: Hex, n: Hex) {
    return this.used.get(`${w.toLowerCase()}:${n}`) ?? null;
  }
  async estimateGas(tx: { to: Hex; data?: Hex }) {
    return tx.data ? 80_000n : 21_000n;
  }
  async gasPrice() {
    return 10_000_000_000n;
  }
  nonces = new Map<string, number>();
  async pendingNonce(a: Hex) {
    return this.nonces.get(a.toLowerCase()) ?? 0;
  }
  async blockNumber() {
    return this.block;
  }

  /** What the real USDC would say about this call, or null if it goes through. Applies it when apply is true. */
  private async usdcRule(from: Hex, data: Hex, apply: boolean, hash?: Hex): Promise<string | null> {
    const { args } = decodeFunctionData({ abi: USDC_ABI, data });
    const [owner, to, value, after, before, nonce, v, r, s] = args as [Hex, Hex, bigint, bigint, bigint, Hex, number, Hex, Hex];
    if (this.time <= after) return "FiatTokenV2: authorization is not yet valid";
    if (this.time >= before) return "FiatTokenV2: authorization is expired";
    if (this.used.has(`${owner.toLowerCase()}:${nonce}`)) return "FiatTokenV2: authorization is used or canceled";
    const signer = await recoverTypedDataAddress({ domain: USDC_DOMAIN, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message: { from: owner, to, value, validAfter: after, validBefore: before, nonce }, signature: { r, s, v: BigInt(v) } });
    if (getAddress(signer) !== getAddress(owner)) return "FiatTokenV2: invalid signature";
    if ((await this.usdcBalance(owner)) < value) return "ERC20: transfer amount exceeds balance";
    if (apply) {
      this.setUsdc(owner, (await this.usdcBalance(owner)) - value);
      this.setUsdc(to, (await this.usdcBalance(to)) + value);
      this.used.set(`${owner.toLowerCase()}:${nonce}`, hash!);
    }
    void from;
    return null;
  }

  async simulate(tx: { from: Hex; to: Hex; data?: Hex; value?: bigint }) {
    if (tx.data && getAddress(tx.to) === getAddress(USDC)) return this.usdcRule(tx.from, tx.data, false);
    return (await this.prosBalance(tx.from)) < (tx.value ?? 0n) ? "insufficient funds" : null;
  }

  async sendRaw(raw: Hex): Promise<Hex> {
    if (this.refuse) throw new Error(this.refuse);
    const hash = keccak256(raw);
    this.rawOf.set(hash, raw);
    if (!this.sent.includes(hash)) this.sent.push(hash);
    this.pool.add(hash);
    if (!this.holdInPool) await this.mine();
    if (this.dropResponse) throw new Error("socket hang up");
    return hash;
  }

  /** Mines everything in the pool, in order, applying the same rules as the real chain. */
  async mine() {
    for (const hash of [...this.pool]) {
      this.pool.delete(hash);
      if (this.receipts.has(hash)) continue;
      const raw = this.rawOf.get(hash)!;
      const tx = parseTransaction(raw);
      const from = (await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })) as Hex;
      this.block++;
      let ok = true;
      if (tx.data && tx.to && getAddress(tx.to) === getAddress(USDC)) ok = (await this.usdcRule(from, tx.data as Hex, true, hash)) === null;
      else {
        const v = tx.value ?? 0n;
        ok = (await this.prosBalance(from)) >= v;
        if (ok) {
          this.setPros(from, (await this.prosBalance(from)) - v);
          this.setPros(tx.to as Hex, (await this.prosBalance(tx.to as Hex)) + v);
        }
      }
      this.nonces.set(from.toLowerCase(), (this.nonces.get(from.toLowerCase()) ?? 0) + 1);
      this.receipts.set(hash, { status: ok ? "success" : "reverted", blockNumber: this.block, gasUsed: tx.data ? 75_000n : 21_000n });
    }
  }
  rawOf = new Map<Hex, Hex>();

  async receipt(hash: Hex) {
    return this.receipts.get(hash) ?? null;
  }
  async knowsTx(hash: Hex) {
    return this.receipts.has(hash) || this.pool.has(hash);
  }
}
