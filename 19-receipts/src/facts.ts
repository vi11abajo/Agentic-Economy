// Every number receipts shows is a Fact with a short id (F7). Every thing it can't tell you is an Unknown with a
// reason from a short, fixed list. Nothing else gets printed as a figure.

export type Reason =
  | "explorer-unreachable" // the explorer didn't answer, so we don't even know what to look at
  | "history-incomplete" // the explorer's history doesn't add up to what the chain holds
  | "explorer-chain-mismatch" // the explorer said one amount, the transaction receipt says another
  | "no-adapter" // the wallet touched a contract we don't know how to read
  | "read-failed" // we know how to read it, but the call reverted or timed out
  | "no-price-route" // no pool on chain we could price it through
  | "received-not-bought" // the token came in as a plain transfer, so this wallet never paid for it
  | "no-cost-basis"; // there's a balance but no incoming history to say what it cost

/** Plain-words version of each reason, for people who don't speak enum. */
export const REASON_TEXT: Record<Reason, string> = {
  "explorer-unreachable": "the explorer did not answer",
  "history-incomplete": "the explorer's history does not add up to the balance on chain",
  "explorer-chain-mismatch": "the explorer and the transaction receipt disagree (the chain's number is used)",
  "no-adapter": "the wallet touched a contract receipts does not know how to read",
  "read-failed": "the read call to the contract failed",
  "no-price-route": "there is no pool on chain to price it through",
  "received-not-bought": "this wallet received it by transfer and never paid for it",
  "no-cost-basis": "there is a balance but no incoming history that shows what it cost",
};

export interface Fact {
  id: string;
  label: string;
  /** What we show, as a plain decimal string ("12.5", "-0.031"). */
  value: string;
  /** Raw integer units when the figure came straight off the chain. */
  raw?: string;
  unit: string;
  contract?: string;
  call?: string;
  tx?: string;
  block: number;
  source: "chain" | "explorer+chain" | "explorer" | "derived";
}

/** A number as plain decimal text, never "3.9e-7": people read it and the answer checker parses it. */
export function plain(x: number, digits = 10): string {
  if (!Number.isFinite(x)) return String(x);
  return x.toLocaleString("en-US", { maximumSignificantDigits: digits, useGrouping: false });
}

export interface Unknown {
  reason: Reason;
  subject: string;
  details: string;
}

/** The scan's notebook: hands out fact ids in order and collects every "can't tell" with its reason. */
export class Ledger {
  private readonly figures: Fact[] = [];
  private readonly blanks: Unknown[] = [];

  add(f: Omit<Fact, "id">): Fact {
    const fact = { id: `F${this.figures.length + 1}`, ...f };
    this.figures.push(fact);
    return fact;
  }

  unknown(u: Unknown): Unknown {
    // The same contract can fail twice in one scan (two questions, one revert); say it once.
    if (!this.blanks.some((b) => b.reason === u.reason && b.subject === u.subject && b.details === u.details)) this.blanks.push(u);
    return u;
  }

  facts(): Fact[] {
    return [...this.figures];
  }

  unknowns(): Unknown[] {
    return [...this.blanks];
  }

  byId(id: string): Fact | undefined {
    return this.figures.find((f) => f.id === id);
  }

  toJSON(): { facts: Fact[]; unknowns: Unknown[] } {
    return { facts: this.facts(), unknowns: this.unknowns() };
  }

  static from(saved: { facts: Fact[]; unknowns: Unknown[] }): Ledger {
    const ledger = new Ledger();
    ledger.figures.push(...saved.facts);
    ledger.blanks.push(...saved.unknowns);
    return ledger;
  }
}
