// From "pay my team every Friday" to a plan the user can say yes to. The agent does the language part and hands
// over whatever it understood; draft() either returns the questions still open (one plain question per gap, so the
// agent can ask them one by one) or a complete plan with an id. Nothing pays until approve() is called with that id,
// and the agent calls it only after the user's explicit yes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress, keccak256, toHex } from "viem";
import { checkEveryMinutes, dueAt, parseWall, type Every } from "./period.js";
import { appendJournal, loadPeople, loadSeries, savePeople, saveSeries, type Hex, type Series } from "./store.js";

export interface DraftInput {
  label?: string;
  token?: string;
  payees?: { name: string; address?: string; amount?: string }[];
  every?: Every;
  first?: string;
  tz?: string;
  checkEveryMinutes?: number;
}

export const DECIMALS = { USDC: 6, PROS: 18 } as const;
const PAST_GRACE_MS = 10 * 60_000;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "series";
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function zoneOk(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function planIdOf(terms: Omit<Series, "id" | "status" | "approvedAt" | "planId">): string {
  return keccak256(toHex(JSON.stringify(terms))).slice(2, 12);
}

export function draft(input: DraftInput, people: Record<string, Hex>, now: Date, home?: string): { missing: string[] } | { plan: Series } {
  const missing: string[] = [];
  const token = input.token?.toUpperCase();
  if (!token) missing.push("Which token: USDC or PROS?");
  else if (token !== "USDC" && token !== "PROS") missing.push(`I can pay in USDC or PROS, not ${input.token}. Which one?`);
  const decimals = token === "PROS" ? DECIMALS.PROS : DECIMALS.USDC;

  if (!input.payees?.length) missing.push("Who should be paid? Names and wallet addresses, please.");
  const payees = (input.payees ?? []).map((p) => {
    const known = Object.keys(people).find((n) => n.toLowerCase() === p.name.toLowerCase());
    const name = known ?? p.name;
    let address = (p.address ?? (known ? people[known] : undefined)) as string | undefined;
    if (!address) missing.push(`What is ${name}'s wallet address on Pharos?`);
    else if (!isAddress(address, { strict: false })) missing.push(`${name}'s address ${address} is not a Pharos address. Could you check it?`);
    else if (/^0x0{40}$/i.test(address)) missing.push(`${name}'s address is the zero address; money sent there is gone. Which address did you mean?`);
    else address = getAddress(address);
    if (!p.amount) missing.push(`How much should ${name} get each time?`);
    else if (!/^\d+(\.\d+)?$/.test(p.amount) || Number(p.amount) <= 0) missing.push(`${name}'s amount must be a number more than zero, got "${p.amount}". How much?`);
    else if ((p.amount.split(".")[1] ?? "").length > decimals) missing.push(`${name}'s amount ${p.amount} has more than ${decimals} decimals, which ${token ?? "the token"} can't carry. How much exactly?`);
    return { name, address: address as Hex, amount: p.amount ?? "" };
  });

  const every = input.every;
  if (!every) missing.push("How often: every week, every month, or something else?");
  else if (!Number.isInteger(every.n) || every.n < 1) missing.push("How often? The period must be a whole number of minutes, hours, days, weeks or months.");

  const tz = input.tz || localZone();
  if (!zoneOk(tz)) missing.push(`I don't know the timezone "${tz}". Which one (for example Europe/Moscow)?`);

  let first = input.first;
  if (!first) missing.push("When should the first payment go out (date and time)?");
  else {
    try {
      parseWall(first);
      if (zoneOk(tz) && every && dueAt(first, tz, every, 0).getTime() < now.getTime() - PAST_GRACE_MS) missing.push(`The first payment time ${first} (${tz}) is already past. When should the first payment go out?`);
    } catch {
      missing.push(`I could not read the first payment time "${first}". Which date and time (like 2026-11-13 09:00)?`);
      first = undefined;
    }
  }

  let check: number | null = null;
  if (every && every.n >= 1) {
    check = checkEveryMinutes(every, input.checkEveryMinutes);
    if (check === null) missing.push(`Payments every ${every.n} minutes are more often than hourly: how often should I check for due payments (in minutes)? I'd suggest every ${Math.max(1, Math.floor(every.n / 5))}.`);
  }

  if (missing.length) return { missing };

  const terms = { label: input.label?.trim() || "Payments", token: token as "USDC" | "PROS", payees, every: every!, first: first!, tz, checkEveryMinutes: check! };
  const plan: Series = { id: slug(terms.label), ...terms, status: "stopped", approvedAt: "", planId: planIdOf(terms) };
  if (home) {
    mkdirSync(join(home, "drafts"), { recursive: true });
    writeFileSync(join(home, "drafts", `${plan.planId}.json`), JSON.stringify(plan, null, 2) + "\n");
  }
  return { plan };
}

/** The user said yes to this exact plan: switch it on, remember the names, write it down. */
export function approve(home: string, planId: string, now: Date): Series {
  const path = join(home, "drafts", `${planId}.json`);
  if (!existsSync(path)) throw new Error(`No draft with plan id ${planId}. Run draft again and show the user the plan.`);
  const plan = JSON.parse(readFileSync(path, "utf8")) as Series;
  const all = loadSeries(home);
  if (all.some((s) => s.planId === planId)) throw new Error(`Plan ${planId} is already approved.`);
  let id = plan.id;
  for (let i = 2; all.some((s) => s.id === id); i++) id = `${plan.id}-${i}`;
  const series: Series = { ...plan, id, status: "active", approvedAt: now.toISOString() };
  saveSeries(home, [...all, series]);
  const people = loadPeople(home);
  for (const p of series.payees) people[p.name] = p.address;
  savePeople(home, people);
  appendJournal(home, { at: now.toISOString(), series: id, period: -1, payee: -1, kind: "approved", planId, label: series.label });
  return series;
}
