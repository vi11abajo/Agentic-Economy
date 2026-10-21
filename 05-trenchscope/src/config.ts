// The user's thresholds. Nothing here has a built-in default: the agent asks for every value on the first run
// (`trenchscope setup` prints the questions) and saves the answers with `trenchscope config set`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isAddress, getAddress } from "viem";

export type Section = "buy" | "sell" | "general";

export interface KeyInfo {
  section: Section;
  label: string;
  unit: "usd" | "count" | "pct" | "hours" | "pros";
  /** What the agent tells the user when asking for it. */
  ask: string;
  /** A starting point the agent can offer. Only used when the user says "take your suggestion". */
  suggest: number;
  /** Advisory checks never block. When they flag, the agent has to ask the user before trading. */
  advisory?: boolean;
}

export const KEYS = {
  // buy: all of these must pass
  max_fdv_usd: { section: "buy", label: "FDV", unit: "usd", suggest: 10_000, ask: "Max fully diluted value in USD (curve price x 1B supply x Chainlink PROS/USD). Skip tokens that are already too big." },
  min_holders: { section: "buy", label: "holders", unit: "count", suggest: 5, ask: "Min number of real holders (Prosper's own contracts don't count, and only bags worth at least holder_min_pros)." },
  max_holder_share_pct: { section: "buy", label: "top holder", unit: "pct", suggest: 5, ask: "Max % of supply any single wallet or contract outside Prosper may hold. A big bag is a dump waiting to happen." },
  min_time_left_hours: { section: "buy", label: "time left", unit: "hours", suggest: 48, ask: "Min hours left before the curve's endsAt. After that there is no graduation to a DEX pool." },
  max_progress_pct: { section: "buy", label: "progress", unit: "pct", suggest: 50, ask: "Max % of the 20,000 PROS graduation target already raised. Above it you're late." },
  advise_max_price_impact_pct: { section: "buy", label: "price impact", unit: "pct", suggest: 3, advisory: true, ask: "Advice only: warn and ask before buying if your size moves the price more than this %." },
  // sell: any of these says get out
  take_profit_pct: { section: "sell", label: "take profit", unit: "pct", suggest: 50, ask: "Exit when the bag is worth this % more than you paid (by quoteSell, after fees)." },
  stop_loss_pct: { section: "sell", label: "stop loss", unit: "pct", suggest: 25, ask: "Exit when the bag is worth this % less than you paid." },
  max_reserve_drop_pct: { section: "sell", label: "liquidity drain", unit: "pct", suggest: 30, ask: "Exit when the PROS in the curve dropped this % since you bought: money is leaving." },
  max_holder_drop: { section: "sell", label: "holder exodus", unit: "count", suggest: 2, ask: "Exit when this many real holders left since you bought." },
  max_whale_share_pct: { section: "sell", label: "whale", unit: "pct", suggest: 5, ask: "Exit when some wallet outside Prosper (not you) holds more than this % of supply." },
  advise_max_slippage_pct: { section: "sell", label: "slippage", unit: "pct", suggest: 5, advisory: true, ask: "Advice only: warn and ask before selling if dumping the whole bag loses more than this % to the curve." },
  // general
  holder_min_pros: { section: "general", label: "holder filter", unit: "pros", suggest: 1, ask: "A wallet counts as a holder only if its bag is worth at least this many PROS (filters out dust)." },
  max_buy_pros: { section: "general", label: "max buy", unit: "pros", suggest: 5, ask: "Never buy more than this many PROS in one go, whatever the request says." },
  tx_slippage_pct: { section: "general", label: "tx slippage", unit: "pct", suggest: 2, ask: "When trading, accept at most this % less than the quote (protects against someone trading right before you)." },
} satisfies Record<string, KeyInfo>;

export type Key = keyof typeof KEYS;
export const ALL_KEYS = Object.keys(KEYS) as Key[];
export const keysOf = (s: Section) => ALL_KEYS.filter((k) => KEYS[k].section === s);

/** The decision checks (not advisory) of a side; take/stop count as one check (P&L). */
export function decisionChecks(side: "buy" | "sell", c: Config): string[] {
  const set = (k: Key) => c.values[k] !== null && c.values[k] !== undefined;
  if (side === "buy") return keysOf("buy").filter((k) => !(KEYS[k] as KeyInfo).advisory && set(k));
  const out: string[] = [];
  if (set("take_profit_pct") || set("stop_loss_pct")) out.push("pnl");
  for (const k of ["max_reserve_drop_pct", "max_holder_drop", "max_whale_share_pct"] as Key[]) if (set(k)) out.push(k);
  return out;
}
export const MIN_CHECKS = 3;

export interface Config {
  wallet: string | null;
  values: Partial<Record<Key, number | null>>;
}

/** TRENCHSCOPE_HOME wins; otherwise %APPDATA%\trenchscope on Windows and ~/.config/trenchscope elsewhere. */
export function homeDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.TRENCHSCOPE_HOME) return env.TRENCHSCOPE_HOME;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "trenchscope");
}

/** Paths for messages: the home folder shown as ~, so the user's name doesn't end up in a transcript. */
export function displayPath(path: string, home = homedir()): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}`.replace(/\\/g, "/") : path.replace(/\\/g, "/");
}

export function loadConfig(home = homeDir()): Config | null {
  const file = join(home, "config.json");
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { wallet?: string | null; buy?: object; sell?: object; general?: object };
  const values = { ...raw.buy, ...raw.sell, ...raw.general } as Config["values"];
  for (const k of Object.keys(values)) if (!(k in KEYS)) delete (values as Record<string, unknown>)[k];
  return { wallet: raw.wallet ?? null, values };
}

export function saveConfig(c: Config, home = homeDir()): string {
  const file = join(home, "config.json");
  const out: Record<string, unknown> = { wallet: c.wallet };
  for (const s of ["buy", "sell", "general"] as Section[]) {
    out[s] = Object.fromEntries(keysOf(s).filter((k) => k in c.values).map((k) => [k, c.values[k] ?? null]));
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  return file;
}

/**
 * Parses "key=value" pairs the way people type them: 10k, $10,000, 5%, 48h, 2d, 1.5 PROS, off.
 * `off` (or none/null/0 for an advisory) turns a check off. Throws on unknown keys and bad values.
 */
export function parseAssignments(pairs: string[], base: Config | null): Config {
  const c: Config = { wallet: base?.wallet ?? null, values: { ...(base?.values ?? {}) } };
  for (const pair of pairs) {
    const m = pair.match(/^([a-z_]+)\s*=\s*(.+)$/i);
    if (!m) throw new Error(`Expected key=value, got "${pair}"`);
    const key = m[1].toLowerCase();
    const raw = m[2].trim();
    if (key === "wallet") {
      if (/^(off|none|null)$/i.test(raw)) c.wallet = null;
      else if (isAddress(raw, { strict: false })) c.wallet = getAddress(raw);
      else throw new Error(`wallet must be a public 0x address (never a private key or seed phrase)`);
      continue;
    }
    if (!(key in KEYS)) throw new Error(`Unknown setting "${key}". Known: wallet, ${ALL_KEYS.join(", ")}`);
    c.values[key as Key] = parseValue(raw, KEYS[key as Key].unit);
  }
  return c;
}

export function parseValue(raw: string, unit: KeyInfo["unit"]): number | null {
  const s = raw.toLowerCase().replace(/[$,\s]/g, "").replace(/(pros|usd|%)$/, "");
  if (/^(off|none|null|disabled?)$/.test(s)) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m|h|d)?$/);
  if (!m) throw new Error(`Can't read "${raw}" as a number`);
  let n = Number(m[1]);
  const suffix = m[2];
  if (suffix === "k") n *= 1_000;
  if (suffix === "m") n *= 1_000_000;
  if (suffix === "d") {
    if (unit !== "hours") throw new Error(`"${raw}": days only make sense for hours`);
    n *= 24;
  }
  if (suffix === "h" && unit !== "hours") throw new Error(`"${raw}": hours only make sense for time_left`);
  if (unit === "pct" && n > 1000) throw new Error(`"${raw}" looks too big for a percent`);
  return n;
}

export function formatValue(v: number | null | undefined, unit: KeyInfo["unit"]): string {
  if (v === null || v === undefined) return "off";
  if (unit === "usd") return `$${v.toLocaleString("en-US")}`;
  if (unit === "pct") return `${v}%`;
  if (unit === "hours") return v % 24 === 0 && v >= 24 ? `${v / 24}d` : `${v}h`;
  if (unit === "pros") return `${v} PROS`;
  return String(v);
}
