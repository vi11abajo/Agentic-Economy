// What the bookkeeper tells the user in Telegram and Discord. run.ts decides what to say, notify.ts how it looks.
import type { Hex } from "./store.js";

export interface PaidLine {
  name: string;
  address: Hex;
  amount: string;
  tx: Hex;
}

export type Card =
  | { kind: "paid"; label: string; series: string; period: number; token: string; tz: string; at: string; lines: PaidLine[] }
  | { kind: "short"; label: string; series: string; period: number; token: string; tz: string; due: string; name: string; amount: string; need: string; have: string; asset: string; wallet: Hex }
  | { kind: "missed"; label: string; series: string; period: number; token: string; tz: string; due: string; name: string; amount: string }
  | { kind: "failed"; label: string; series: string; period: number; token: string; tz: string; name: string; amount: string; reason: string; tx?: Hex }
  | { kind: "runway"; wallet: Hex; usdc: string; pros: string; lines: RunwayLine[] }
  | { kind: "test"; wallet: Hex | null };

export interface RunwayLine {
  series: string;
  label: string;
  token: string;
  tz: string;
  perPeriod: string; // token amount one period needs
  nextDue: string | null; // ISO
  coversPeriods: number; // how many of the coming periods the wallet covers, capped at RUNWAY_CAP
  until: string | null; // ISO due time of the last covered period
  nextShort: boolean;
}

export const RUNWAY_CAP = 52;

export interface Notifier {
  /** Throws when no configured channel took the card; the run then tries again next time. */
  send(card: Card): Promise<void>;
  readonly channels: string[];
}
