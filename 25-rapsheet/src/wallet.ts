// The record of a plain wallet: how long it has existed, who paid for its first gas and what that payer was doing at
// the time, and which approvals it left open. That last one also matters for you: a wallet that hands unlimited
// allowances to strangers is either careless or a drainer's helper, and you'd be trusting it either way.
import { approvalsNaming } from "./approvals.js";
import type { ApprovalLog, Chain } from "./chain.js";
import type { Explorer, Hex, Listing, Profile, Tx } from "./explorer.js";
import { addressLink, ago, days, plural, short, txLink, type Finding } from "./finding.js";

export const WALLET_LIMITS = {
  /** A wallet whose first transaction is younger than this is MEDIUM. */
  newDays: 2,
  /** Funded this recently with this few transactions sent: freshly funded. */
  freshHours: 48,
  freshNonce: 3,
  /** A funder that paid this many distinct wallets within an hour of funding this one sprayed gas around. */
  sprayWallets: 10,
  sprayWindowSeconds: 3600,
  /** How many of the latest approvals we look up on the chain. */
  approvalsToCheck: 40,
  /** From here on an allowance is "unlimited" for any token that exists. */
  unlimited: 2n ** 128n,
};

export const APPROVE = "0x095ea7b3";

export interface WalletLook {
  target: Hex;
  chain: Chain;
  explorer: Explorer;
  now: number;
  head: number;
  /** How many recent blocks to scan for approvals naming this wallet. */
  window: number;
  profile: Profile;
  txs: Listing<Tx>;
}

function age(l: WalletLook): Finding {
  // the explorer's "first transaction" can be the first one the wallet sent, after it was funded; the older wins
  const f = l.profile.funding;
  const first = f && (!l.profile.firstTx || f.time < l.profile.firstTx.time) ? { hash: f.hash, time: f.time, block: null } : l.profile.firstTx;
  if (!first) {
    return {
      id: "wallet_age",
      title: "How long the wallet has existed",
      level: "medium",
      said: "It has no history at all: the explorer has never seen a transaction to or from it.",
      why: "An address nobody has used gives you nothing to go on. If someone asked you to pay it, check it really is theirs.",
      source: "explorer",
      evidence: [addressLink(l.target)],
    };
  }
  const old = l.now - first.time;
  const level = days(old) < WALLET_LIMITS.newDays ? "medium" : "ok";
  return {
    id: "wallet_age",
    title: "How long the wallet has existed",
    level,
    said: `Its first transaction was ${ago(old)} ago${first.block ? ` (block ${first.block})` : ", when it was funded"}.`,
    why: level === "ok" ? "" : "A wallet this new has no track record. Scam and drainer wallets are usually created for one job and thrown away.",
    source: "explorer",
    evidence: [txLink(first.hash, `first tx ${short(first.hash)}`)],
  };
}

async function funding(l: WalletLook): Promise<Finding[]> {
  const f = l.profile.funding;
  if (!f) {
    return [
      {
        id: "fresh_funding",
        title: "Who paid for its first gas",
        level: "unchecked",
        said: "The explorer doesn't show who first funded this wallet.",
        why: "",
        source: "explorer",
        evidence: [addressLink(l.target)],
      },
    ];
  }
  const out: Finding[] = [];
  const nonce = await l.chain.nonce(l.target);
  const fresh = (l.now - f.time) / 3600 < WALLET_LIMITS.freshHours && nonce <= WALLET_LIMITS.freshNonce;
  out.push({
    id: "fresh_funding",
    title: "Who paid for its first gas",
    level: fresh ? "medium" : "ok",
    said: `${short(f.from)} sent it ${f.value} PROS ${ago(l.now - f.time)} ago, and it has sent ${plural(nonce, "transaction")} of its own since${fresh ? "" : "."}${fresh ? ": it was funded just now and has barely been used." : ""}`,
    why: fresh ? "Freshly funded wallets that are about to receive or approve something are the classic shape of a throwaway scam account." : "",
    source: "chain+explorer",
    evidence: [txLink(f.hash, `funding tx ${short(f.hash)}`), addressLink(f.from, `funder ${short(f.from)}`)],
  });

  // What was the funder doing around that moment? One wallet paying gas to a crowd of new wallets within the hour is
  // how sybil farms and drainer crews set up their accounts. Exchanges and bridges do the same all day, so a busy,
  // long-lived funder only gets a note.
  const fp = await l.explorer.profile(f.from);
  if (fp.isContract) {
    out.push({
      id: "funder",
      title: "What the funder is",
      level: "info",
      said: `The first PROS came through a contract, ${fp.name ?? short(f.from)} (a bridge, router or faucet, for example).`,
      why: "",
      source: "explorer",
      evidence: [addressLink(f.from)],
    });
    return out;
  }
  const sent = await l.explorer.txs(f.from, 1000);
  const near = sent.rows.filter((t) => t.from === f.from && t.to && t.methodId === "0x" && Number(t.value) > 0 && Math.abs(t.time - f.time) <= WALLET_LIMITS.sprayWindowSeconds);
  const wallets = new Set(near.map((t) => t.to));
  const amounts = new Map<string, number>();
  for (const t of near) amounts.set(t.value, (amounts.get(t.value) ?? 0) + 1);
  const sameAmount = Math.max(0, ...amounts.values());
  const funderAge = fp.firstTx ? l.now - fp.firstTx.time : 0;
  const busy = sent.total > 5000 && days(funderAge) > 30;
  const spray = wallets.size >= WALLET_LIMITS.sprayWallets && !busy;
  const seen = sent.cut && near.length === 0 ? " (its history is too long to read back to that moment)" : "";
  out.push({
    id: "funder",
    title: "What the funder was doing",
    level: spray ? "medium" : busy ? "info" : "ok",
    said:
      `Within an hour of funding it, ${short(f.from)} sent PROS to ${plural(wallets.size, "wallet")}` +
      (wallets.size > 1 && sameAmount > 1 ? `, ${sameAmount} of them the exact same amount` : "") +
      `. The funder itself is ${fp.firstTx ? ago(funderAge) : "of unknown age"} old with ${plural(sent.total, "transaction")}${seen}.`,
    why: spray
      ? "One wallet seeding many new wallets at once is how farms and drainer crews set up throwaway accounts."
      : busy
        ? "A long-lived address this busy is most likely an exchange or a service paying out withdrawals, so this tells us little."
        : "",
    source: "explorer",
    evidence: [addressLink(f.from, `funder ${short(f.from)}`)],
  });
  return out;
}

interface Approval {
  token: Hex;
  spender: Hex;
  hash: Hex;
  time: number;
}

async function approvals(l: WalletLook): Promise<Finding[]> {
  const sent = l.txs.rows.filter((t) => t.from === l.target && t.to && t.ok && t.methodId === APPROVE).slice(0, WALLET_LIMITS.approvalsToCheck);
  const latest = new Map<string, Approval>();
  for (const t of sent) {
    const input = await l.chain.txInput(t.hash);
    if (!input || input.length < 138) continue;
    const spender = `0x${input.slice(34, 74)}`.toLowerCase() as Hex;
    const key = `${t.to}:${spender}`;
    if (!latest.has(key)) latest.set(key, { token: t.to!, spender, hash: t.hash, time: t.time });
  }

  const out: Finding[] = [];
  let open = 0;
  for (const a of latest.values()) {
    const left = await l.chain.allowance(a.token, l.target, a.spender);
    if (!left) continue;
    open++;
    const unlimited = left >= WALLET_LIMITS.unlimited;
    const isWallet = (await l.chain.code(a.spender)) === "0x";
    const what = unlimited ? "an unlimited allowance" : "an allowance";
    const ev = [txLink(a.hash, `approve tx ${short(a.hash)}`), addressLink(a.spender, `spender ${short(a.spender)}`), addressLink(a.token, `token ${short(a.token)}`)];
    if (isWallet) {
      out.push({
        id: "open_approvals",
        title: "Approvals it left open",
        level: "high",
        said: `It gave a plain wallet, ${short(a.spender)}, ${what} on token ${short(a.token)} ${ago(l.now - a.time)} ago, and it is still open today.`,
        why: "Apps take approvals through contracts. An approval to a bare wallet lets one person move those tokens whenever they like: it's the shape of an approval drain, from either side.",
        source: "chain+explorer",
        evidence: ev,
      });
      continue;
    }
    if (!unlimited) continue;
    const sp = await l.explorer.profile(a.spender);
    const young = sp.createdAt !== null && days(l.now - sp.createdAt) < 14;
    if (sp.verified === true && !young) continue;
    const own = sp.creator === l.target;
    out.push({
      id: "open_approvals",
      title: "Approvals it left open",
      level: own ? "info" : "medium",
      said: `It gave ${short(a.spender)} an unlimited allowance on token ${short(a.token)}, still open today; that contract is ${[sp.verified === false ? "unverified" : null, young && sp.createdAt ? `${ago(l.now - sp.createdAt)} old` : null].filter(Boolean).join(" and ")}.`,
      why: "An unlimited approval lets the spender take every one of those tokens, now or later, for as long as it stays open. Against code nobody can read, that's a blank cheque.",
      source: "chain+explorer",
      evidence: ev,
      easing: own ? "The wallet deployed that contract itself, so this looks like its own bot or vault rather than a stranger." : undefined,
    });
  }
  if (out.length === 0) {
    out.push({
      id: "open_approvals",
      title: "Approvals it left open",
      level: "ok",
      said:
        latest.size === 0
          ? "It has never sent an approve transaction that the explorer lists."
          : `Of ${plural(latest.size, "approval")} we looked up on the chain, ${open} ${open === 1 ? "is" : "are"} still open: none to a plain wallet, and no unlimited one to an unverified contract or one younger than 14 days.`,
      why: "",
      source: "chain+explorer",
      evidence: [addressLink(l.target)],
    });
  }
  if (l.txs.cut) {
    out.push({
      id: "older_history",
      title: "Older history",
      level: "unchecked",
      said: `It has ${plural(l.txs.total, "transaction")}; we read the latest ${l.txs.rows.length}, so approvals older than that weren't looked at.`,
      why: "",
      source: "explorer",
      evidence: [addressLink(l.target)],
    });
  }
  return out;
}

// The other side of an approval drain: who has given THIS wallet the right to move their tokens? Apps take
// approvals through contracts, so a plain wallet holding open allowances from other people is the drainer's own
// account (or a very unusual setup). No index lists approvals by spender, so this one is a log scan over a recent
// window, and the report says how far back it looked.
async function approvalsReceived(l: WalletLook): Promise<Finding[]> {
  const { logs, span } = await approvalsNaming(l.chain, l.target, l.head, l.window);
  const latest = new Map<string, ApprovalLog>();
  for (const a of logs) if (a.owner !== l.target && !latest.has(`${a.token}:${a.owner}`)) latest.set(`${a.token}:${a.owner}`, a);

  const open: { a: ApprovalLog; left: bigint }[] = [];
  for (const a of latest.values()) {
    const left = await l.chain.allowance(a.token, a.owner, l.target);
    if (left) open.push({ a, left });
  }
  if (open.length > 0) {
    const owners = new Set(open.map((o) => o.a.owner));
    const first = open[0];
    return [
      {
        id: "approvals_received",
        title: "Who lets it move their tokens",
        level: "high",
        said:
          `${plural(owners.size, "other wallet")} gave this plain wallet the right to move their tokens, and ${open.length === 1 ? "it is" : "they are"} still open: ` +
          `${short(first.a.owner)} on token ${short(first.a.token)}${first.left >= WALLET_LIMITS.unlimited ? " (unlimited)" : ""}${open.length > 1 ? `, and ${open.length - 1} more` : ""}. Seen in ${span}.`,
        why: "Apps take approvals through contracts. A bare wallet collecting other people's approvals can pull their tokens whenever it likes: that's how approval drainers get paid.",
        source: "chain",
        evidence: open.slice(0, 3).flatMap((o) => [txLink(o.a.hash, `approval ${short(o.a.hash)}`), addressLink(o.a.owner, `owner ${short(o.a.owner)}`)]),
      },
    ];
  }
  return [
    {
      id: "approvals_received",
      title: "Who lets it move their tokens",
      level: "ok",
      said: latest.size === 0 ? `Nobody approved it to move their tokens in ${span}.` : `${plural(latest.size, "approval")} named it in ${span}, all closed again since.`,
      why: "",
      source: "chain",
      evidence: [addressLink(l.target)],
    },
    {
      id: "approvals_received_older",
      title: "Approvals given to it earlier",
      level: "unchecked",
      said: `Approvals older than ${span} weren't scanned (no index lists them by spender).`,
      why: "",
      source: "chain",
      evidence: [addressLink(l.target)],
    },
  ];
}

export async function walletRecord(l: WalletLook): Promise<Finding[]> {
  return [age(l), ...(await funding(l)), ...(await approvals(l)), ...(await approvalsReceived(l))];
}
