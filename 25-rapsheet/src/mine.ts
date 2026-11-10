// Risk depends on who's asking. The same address can be fine for everyone else and a trap for you: an address
// poisoner creates a wallet whose first and last characters match someone you pay, sends you a zero or dust transfer
// from it so it sits in your history, and waits for you to copy the wrong one. Only your own history shows that.
import type { Explorer, Hex, Transfer, Tx } from "./explorer.js";
import { addressLink, ago, plural, short, txLink, type Finding } from "./finding.js";

/** Below this many tokens a transfer is dust: worth nothing, sent only to show up in your history. */
export const DUST = 0.001;

/** What a quick glance compares: the first 4 and last 4 characters after 0x. */
export const glance = (a: string) => `${a.slice(2, 6)}…${a.slice(-4)}`.toLowerCase();

export interface MyHistory {
  txs: Tx[];
  transfers: Transfer[];
}

export async function myHistory(explorer: Explorer, me: Hex): Promise<MyHistory> {
  const [t, x] = await Promise.all([explorer.txs(me), explorer.transfers(me)]);
  return { txs: t.rows, transfers: x.rows };
}

export function relativeToMe(target: Hex, me: Hex, h: MyHistory, now: number): Finding[] {
  const out: Finding[] = [];
  const touched = [...h.txs.filter((t) => t.from === target || t.to === target), ...h.transfers.filter((t) => t.from === target || t.to === target)];

  // who you've paid, newest first, with the tx you paid them in
  const paid = new Map<Hex, { hash: Hex; time: number }>();
  for (const t of h.txs) if (t.from === me && t.to && !paid.has(t.to)) paid.set(t.to, { hash: t.hash, time: t.time });
  for (const t of h.transfers) if (t.from === me && !paid.has(t.to)) paid.set(t.to, { hash: t.hash, time: t.time });

  if (touched.length > 0) {
    const last = Math.max(...touched.map((t) => t.time));
    out.push({
      id: "first_contact",
      title: "Have you dealt with it before",
      level: "info",
      said: `Yes: it appears ${touched.length === 1 ? "once" : `${touched.length} times`} in your history, the last time ${ago(now - last)} ago.`,
      why: "",
      source: "you",
      evidence: [txLink(touched[0].hash)],
    });
  } else {
    out.push({
      id: "first_contact",
      title: "Have you dealt with it before",
      level: "info",
      said: "No: this would be your first transaction with this address.",
      why: "First contact is when a wrong address costs the most. Check it against where you got it from, character by character.",
      source: "you",
      evidence: [addressLink(target)],
    });
  }

  const twins = [...paid.entries()].filter(([a]) => a !== target && glance(a) === glance(target));
  for (const [a, p] of twins.slice(0, 3)) {
    out.push({
      id: "look_alike",
      title: "Does it imitate someone you pay",
      level: "high",
      said: `It looks like ${short(a)}, an address you paid ${ago(now - p.time)} ago: same first and last four characters, but a different address.`,
      why: "That's address poisoning. Someone made a wallet that matches the ends of one you use, hoping you'll copy it from your history. Sending here sends to them.",
      source: "you",
      evidence: [addressLink(a, `the real one ${short(a)}`), txLink(p.hash, `your payment ${short(p.hash)}`)],
    });
  }

  const dust = [
    ...h.transfers.filter((t) => t.from === target && t.to === me && Number(t.value) < DUST).map((t) => ({ hash: t.hash, time: t.time, what: `${t.value} ${t.symbol}` })),
    ...h.txs.filter((t) => t.from === target && t.to === me && Number(t.value) === 0).map((t) => ({ hash: t.hash, time: t.time, what: "an empty transaction" })),
  ];
  if (dust.length > 0) {
    out.push({
      id: "dust_to_me",
      title: "Did it send you worthless transfers",
      level: twins.length > 0 ? "high" : "medium",
      said: `It sent you ${plural(dust.length, "worthless transfer")} (${dust[0].what}, ${ago(now - dust[0].time)} ago).`,
      why: "Nobody sends zero for a reason you'd like. It puts the address into your history so you'll pick it next time.",
      source: "you",
      evidence: dust.slice(0, 3).map((d) => txLink(d.hash)),
    });
  }

  if (twins.length === 0) {
    out.push({
      id: "look_alike",
      title: "Does it imitate someone you pay",
      level: "ok",
      said: `No: none of the ${plural(paid.size, "address")} you've paid shares its first and last four characters.`,
      why: "",
      source: "you",
      evidence: [addressLink(me, "your history")],
    });
  }
  return out;
}
