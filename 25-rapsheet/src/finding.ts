// One line of the record. Every finding says what we saw in plain words, why it matters, where we saw it (the chain,
// the explorer or both) and links to the thing itself, so nobody has to take our word for it.
import { EXPLORER_ADDRESS, EXPLORER_BLOCK, EXPLORER_TX } from "./chain.js";
import type { Hex } from "./explorer.js";

export type Level = "ok" | "info" | "medium" | "high" | "unchecked";
export type Source = "chain" | "explorer" | "chain+explorer" | "you";

export interface Evidence {
  label: string;
  url: string;
}

export interface Finding {
  id: string;
  title: string;
  level: Level;
  /** What we saw, in a sentence a non-developer can read. */
  said: string;
  /** Why it matters. Empty for ok lines that need no explanation. */
  why: string;
  source: Source;
  evidence: Evidence[];
  /** Something that makes the flag less worrying. Shown next to it, never used to lower a HIGH. */
  easing?: string;
}

export const txLink = (hash: Hex, label = `tx ${short(hash)}`): Evidence => ({ label, url: EXPLORER_TX + hash });
export const addressLink = (a: Hex, label = short(a)): Evidence => ({ label, url: EXPLORER_ADDRESS + a });
export const blockLink = (n: number): Evidence => ({ label: `block ${n}`, url: EXPLORER_BLOCK + n });

export function short(h: string): string {
  return h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

const DAY = 86_400;

/** "3 hours", "5 days", "4 months": the way you'd say it out loud. */
export function ago(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 3600) return plural(Math.max(1, Math.round(s / 60)), "minute");
  if (s < 2 * DAY) return plural(Math.round(s / 3600), "hour");
  if (s < 60 * DAY) return plural(Math.round(s / DAY), "day");
  return plural(Math.round(s / (30 * DAY)), "month");
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const days = (seconds: number) => seconds / DAY;
