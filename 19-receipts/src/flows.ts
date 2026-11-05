// The explorer gives three flat lists (txs, token transfers, internal PROS moves). For anything interesting we need
// them per transaction: what left the wallet, what came back, and who the wallet was talking to.
import type { WalletIndex } from "./explorer.js";

export interface Move {
  token: string; // "native" for PROS itself
  counterparty: string;
  /** Decimal string exactly as the explorer printed it. The chain gets the final word later. */
  amount: string;
  logIndex?: number;
}

export interface Flow {
  hash: string;
  block: number;
  /** Who sent the transaction. Not always the wallet: someone can buy a token and have it delivered here. */
  sender: string | null;
  /** What the transaction called. */
  target: string | null;
  method: string | null;
  out: Move[];
  in: Move[];
}

export function groupFlows(ix: WalletIndex): Flow[] {
  const w = ix.wallet.toLowerCase();
  const byHash = new Map<string, Flow>();
  const flow = (hash: string, block: number): Flow => {
    let f = byHash.get(hash);
    if (!f) {
      f = { hash, block, sender: null, target: null, method: null, out: [], in: [] };
      byHash.set(hash, f);
    }
    return f;
  };
  for (const tx of ix.txs) {
    if (tx.receipt_status !== 1) continue; // a failed tx moved nothing (except gas)
    const f = flow(tx.hash, tx.block_number);
    f.sender = tx.from_address.toLowerCase();
    f.target = tx.to_address?.toLowerCase() ?? null;
    f.method = tx.method_id;
    if (f.sender === w && Number(tx.value) > 0 && f.target !== w) f.out.push({ token: "native", counterparty: f.target ?? "", amount: tx.value });
  }
  for (const t of ix.transfers) {
    const f = flow(t.transaction_hash, t.block_number);
    const from = t.from_address.toLowerCase();
    const to = t.to_address.toLowerCase();
    if (from === w && to === w) continue;
    if (from === w) f.out.push({ token: t.token_address.toLowerCase(), counterparty: to, amount: t.value, logIndex: t.log_index });
    if (to === w) f.in.push({ token: t.token_address.toLowerCase(), counterparty: from, amount: t.value, logIndex: t.log_index });
  }
  for (const i of ix.internals) {
    if (!i.transaction_hash || Number(i.value) <= 0) continue;
    const f = flow(i.transaction_hash, i.block_number ?? 0);
    if (i.to_address.toLowerCase() === w && i.from_address.toLowerCase() !== w) f.in.push({ token: "native", counterparty: i.from_address.toLowerCase(), amount: i.value });
    if (i.from_address.toLowerCase() === w && i.to_address.toLowerCase() !== w) f.out.push({ token: "native", counterparty: i.to_address.toLowerCase(), amount: i.value });
  }
  return [...byHash.values()].sort((a, b) => b.block - a.block);
}
