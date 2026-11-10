// Puts the record together: what the address is, its own history, how it relates to you, and your watchlist.
import type { Chain } from "./chain.js";
import { contractRecord } from "./contract.js";
import type { Explorer, Hex, Listing, Tx } from "./explorer.js";
import { addressLink, short, txLink, type Finding } from "./finding.js";
import { myHistory, relativeToMe } from "./mine.js";
import { verdict, type Verdict } from "./verdict.js";
import { walletRecord } from "./wallet.js";

export interface WatchEntry {
  address: Hex;
  reason: string;
  source: string;
}

/** About a day of Pharos blocks (they come roughly every 0.94 s). */
export const DEFAULT_WINDOW = 100_000;

export interface Options {
  /** Recent blocks to scan for approvals that name a wallet as spender. */
  window?: number;
  me?: Hex;
  watchlist?: WatchEntry[];
  now?: number;
}

export interface Report {
  target: Hex;
  kind: "wallet" | "contract";
  name: string | null;
  head: number;
  time: number;
  me: Hex | null;
  findings: Finding[];
  verdict: Verdict;
}

// Your own list: addresses you (or someone you trust) already know are bad, each with the reason and where it came
// from. We know of no public blacklist for Pharos, so rapsheet ships with none and says so instead of inventing one.
function watched(target: Hex, list: WatchEntry[], txs: Listing<Tx> | null): Finding[] {
  if (list.length === 0) return [];
  const byAddress = new Map(list.map((w) => [w.address.toLowerCase(), w]));
  const hit = byAddress.get(target);
  if (hit) {
    return [
      {
        id: "watchlist",
        title: "Is it on your watchlist",
        level: "high",
        said: `Yes: ${hit.reason} (source: ${hit.source}).`,
        why: "You or someone you trust already marked this address.",
        source: "you",
        evidence: [addressLink(target)],
      },
    ];
  }
  const dealt = (txs?.rows ?? []).flatMap((t) => [t.from, t.to].filter((a): a is Hex => !!a && a !== target && byAddress.has(a)).map((a) => ({ a, t })));
  if (dealt.length > 0) {
    const w = byAddress.get(dealt[0].a)!;
    return [
      {
        id: "watchlist",
        title: "Has it dealt with addresses on your watchlist",
        level: "high",
        said: `Yes: it transacted with ${short(dealt[0].a)}, which is on your list (${w.reason}; source: ${w.source})${dealt.length > 1 ? `, ${dealt.length} times in all` : ""}.`,
        why: "Money that moves to or from a known bad address is often part of the same operation.",
        source: "you",
        evidence: dealt.slice(0, 3).map((d) => txLink(d.t.hash)),
      },
    ];
  }
  return [
    {
      id: "watchlist",
      title: "Is it on your watchlist",
      level: "ok",
      said: `No: neither it nor anyone in its last ${txs?.rows.length ?? 0} transactions is on your list of ${list.length}.`,
      why: "",
      source: "you",
      evidence: [addressLink(target)],
    },
  ];
}

export async function rapsheet(target: Hex, chain: Chain, explorer: Explorer, opts: Options = {}): Promise<Report> {
  const t = target.toLowerCase() as Hex;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const [profile, code, head] = await Promise.all([explorer.profile(t), chain.code(t), chain.head()]);
  const isContract = code !== "0x";
  const findings: Finding[] = [];

  // the chain decides what it is; the explorer only names it
  findings.push({
    id: "kind",
    title: "What it is",
    level: "info",
    said: isContract ? `A contract${profile.name ? ` the explorer calls ${profile.name}` : " with no name on the explorer"}.` : "A plain wallet: someone's private key, no code.",
    why: "",
    source: "chain",
    evidence: [addressLink(t)],
  });

  let txs: Listing<Tx> | null = null;
  if (isContract) {
    findings.push(...(await contractRecord({ target: t, chain, explorer, head, now, profile, code })));
  } else {
    txs = await explorer.txs(t);
    findings.push(...(await walletRecord({ target: t, chain, explorer, now, head, window: opts.window ?? DEFAULT_WINDOW, profile, txs })));
  }

  if (opts.me) {
    const me = opts.me.toLowerCase() as Hex;
    findings.push(...relativeToMe(t, me, await myHistory(explorer, me), now));
  }
  findings.push(...watched(t, opts.watchlist ?? [], txs));

  return { target: t, kind: isContract ? "contract" : "wallet", name: profile.name, head, time: now, me: opts.me?.toLowerCase() as Hex ?? null, findings, verdict: verdict(findings) };
}
