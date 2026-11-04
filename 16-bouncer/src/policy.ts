// The policy file: the user's rules, in plain JSON they can read and edit. It is parsed strictly, because a rule
// bouncer misread is worse than no rule: an unknown key, a bad address or an amount with too many decimals makes
// the whole file refuse to load (and then every request is denied by rule "policy" until it's fixed).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isAddress, keccak256, parseUnits, toBytes, type Address, type Hex } from "viem";

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = (typeof DAYS)[number];

export type SpendCap = { token?: Address; decimals: number; perTx: bigint; perDay: bigint };
export type Policy = {
  name: string;
  wallet: Address;
  /** from/to are minutes after 00:00 UTC; to is exclusive and may be smaller than from (wraps midnight). */
  timeWindow?: { days: Day[]; from: number; to: number };
  contracts: Address[];
  recipients: Address[];
  approvals: { spenders: Address[]; unlimited: boolean };
  /** Keyed by the name the user gave the asset: "PROS" or e.g. "USDC". */
  spend: Record<string, SpendCap>;
};

const TOP_KEYS = ["name", "wallet", "time_window", "contracts", "recipients", "approvals", "spend"];

/** "0.001" in an asset with `decimals` places, as raw units. Null for anything we'd have to guess about. */
export function toUnits(text: unknown, decimals: number): bigint | null {
  if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text)) return null;
  const fraction = text.split(".")[1] ?? "";
  if (fraction.length > decimals) return null;
  return parseUnits(text, decimals);
}

const minutesOf = (hhmm: unknown): number | null => {
  const m = typeof hhmm === "string" ? hhmm.match(/^(\d{2}):(\d{2})$/) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

export function parsePolicy(json: unknown): { policy: Policy } | { problems: string[] } {
  const problems: string[] = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) return { problems: ["the policy must be a JSON object"] };
  const raw = json as Record<string, unknown>;
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) problems.push(`unknown key "${k}" (known: ${TOP_KEYS.join(", ")})`);

  const address = (v: unknown, where: string): Address | null => {
    if (typeof v === "string" && isAddress(v, { strict: false })) return v.toLowerCase() as Address;
    problems.push(`${where}: "${String(v)}" is not an address`);
    return null;
  };
  const addressList = (v: unknown, where: string): Address[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      problems.push(`${where} must be a list of addresses`);
      return [];
    }
    return v.map((a, i) => address(a, `${where}[${i}]`)).filter((a): a is Address => a !== null);
  };

  const wallet = raw.wallet === undefined ? (problems.push("wallet is missing: whose money are these rules for?"), null) : address(raw.wallet, "wallet");

  let timeWindow: Policy["timeWindow"];
  if (raw.time_window !== undefined) {
    const tw = (raw.time_window ?? {}) as Record<string, unknown>;
    const from = minutesOf(tw.from);
    const to = minutesOf(tw.to);
    if (from === null) problems.push(`time_window.from "${String(tw.from)}" is not a HH:MM time`);
    if (to === null) problems.push(`time_window.to "${String(tw.to)}" is not a HH:MM time`);
    if (tw.tz !== undefined && tw.tz !== "UTC") problems.push(`time_window.tz "${String(tw.tz)}": only UTC for now`);
    const days = tw.days === undefined ? [...DAYS] : tw.days;
    const badDays = Array.isArray(days) ? days.filter((d) => !DAYS.includes(d as Day)) : ["(not a list)"];
    if (badDays.length) problems.push(`time_window.days: ${badDays.join(", ")} (use ${DAYS.join(", ")})`);
    if (from !== null && to !== null && from === to) problems.push("time_window.from and .to are the same: that window never opens");
    if (from !== null && to !== null && !badDays.length) timeWindow = { days: days as Day[], from, to };
  }

  const contracts = addressList(raw.contracts, "contracts");
  const recipients = addressList(raw.recipients, "recipients");
  const ap = (raw.approvals ?? {}) as Record<string, unknown>;
  const approvals = { spenders: addressList(ap.spenders, "approvals.spenders"), unlimited: ap.unlimited === true };

  const spend: Record<string, SpendCap> = {};
  const rawSpend = (raw.spend ?? {}) as Record<string, Record<string, unknown>>;
  for (const [asset, cap] of Object.entries(rawSpend)) {
    const isPros = asset === "PROS";
    const token = isPros ? undefined : cap.token === undefined ? (problems.push(`spend.${asset}: needs "token" (its contract address)`), null) : address(cap.token, `spend.${asset}.token`);
    const decimals = isPros ? 18 : typeof cap.decimals === "number" && Number.isInteger(cap.decimals) && cap.decimals >= 0 && cap.decimals <= 36 ? cap.decimals : (problems.push(`spend.${asset}: needs "decimals" (a whole number)`), null);
    if (decimals === null || token === null) continue;
    const perTx = toUnits(cap.per_tx, decimals);
    const perDay = toUnits(cap.per_day, decimals);
    if (perTx === null) problems.push(`spend.${asset}.per_tx "${String(cap.per_tx)}" must be a plain decimal string with at most ${decimals} decimals`);
    if (perDay === null) problems.push(`spend.${asset}.per_day "${String(cap.per_day)}" must be a plain decimal string with at most ${decimals} decimals`);
    if (perTx !== null && perDay !== null) spend[asset] = { ...(token ? { token } : {}), decimals, perTx, perDay };
  }

  if (problems.length || !wallet) return { problems };
  return {
    policy: {
      name: typeof raw.name === "string" ? raw.name : "unnamed policy",
      wallet,
      ...(timeWindow ? { timeWindow } : {}),
      contracts,
      recipients,
      approvals,
      spend,
    },
  };
}

export const policyHash = (text: string): Hex => keccak256(toBytes(text));

export function loadPolicy(home: string): { policy: Policy; hash: Hex } | { problems: string[] } {
  const file = join(home, "policy.json");
  if (!existsSync(file)) return { problems: [`no policy.json in ${home}: run "bouncer policy init" to start from the example`] };
  const text = readFileSync(file, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { problems: [`policy.json isn't valid JSON: ${(err as Error).message}`] };
  }
  const parsed = parsePolicy(json);
  return "problems" in parsed ? parsed : { policy: parsed.policy, hash: policyHash(text) };
}
