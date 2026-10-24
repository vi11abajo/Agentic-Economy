// Settings: trade sizes, the profit threshold, and each exchange's fees for a regular user (checked 2026-10-24:
// OKX fee page, spot group 1 base tier; Bitget and MEXC from their public symbol APIs; PROS withdrawal fees on
// the Pharos network from each exchange's fee page or public coin API). Every value can be changed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Exchange } from "./cex.js";

export interface ExchangeFees {
  taker_pct: number;
  /** PROS withdrawal fee to the Pharos network: what it costs to move the PROS bought here to the other side. */
  withdraw_pros: number;
  deposit_pros: number;
}

export interface Settings {
  sizes_usd: number[];
  min_net_usd: number;
  min_net_pct: number;
  /** Count the PROS withdrawal needed to rebalance after each trade. */
  rebalance: boolean;
  /** Gas a real swap transaction adds on top of the pool's own swap (base cost, token transfers, router). */
  dex_overhead_gas: number;
  /** Pools with less USDC than this are left out. */
  min_pool_usdc: number;
  /** A venue more than this % off Chainlink PROS/USD is treated as bad data for that scan. */
  max_oracle_gap_pct: number;
  /** A pool swap that fills more than this % worse than the pool's mid price counts as "can't fill this size". */
  max_dex_impact_pct: number;
  exchanges: Record<Exchange, ExchangeFees>;
}

export const DEFAULTS: Settings = {
  sizes_usd: [50, 200, 1000],
  min_net_usd: 1,
  min_net_pct: 0.1,
  rebalance: true,
  dex_overhead_gas: 61_000,
  min_pool_usdc: 1_000,
  max_oracle_gap_pct: 5,
  max_dex_impact_pct: 20,
  exchanges: {
    okx: { taker_pct: 0.1, withdraw_pros: 0.00027, deposit_pros: 0 },
    bitget: { taker_pct: 0.1, withdraw_pros: 0.149, deposit_pros: 0 },
    mexc: { taker_pct: 0.08, withdraw_pros: 0.2, deposit_pros: 0 },
  },
};

export function homeDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.PROSARB_HOME) return env.PROSARB_HOME;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "pros-arbitrage");
}

export function displayPath(p: string, home = homedir()): string {
  return (p.startsWith(home) ? `~${p.slice(home.length)}` : p).replace(/\\/g, "/");
}

export function load(home = homeDir()): Settings {
  const f = join(home, "config.json");
  const saved = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Partial<Settings>) : {};
  return {
    ...DEFAULTS,
    ...saved,
    exchanges: {
      okx: { ...DEFAULTS.exchanges.okx, ...saved.exchanges?.okx },
      bitget: { ...DEFAULTS.exchanges.bitget, ...saved.exchanges?.bitget },
      mexc: { ...DEFAULTS.exchanges.mexc, ...saved.exchanges?.mexc },
    },
  };
}

export function save(s: Settings, home = homeDir()): string {
  mkdirSync(home, { recursive: true });
  const f = join(home, "config.json");
  writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`);
  return f;
}

/** "min_net_usd=0.5", "sizes_usd=100,500", "okx.taker_pct=0.08", "rebalance=off". */
export function apply(s: Settings, pairs: string[]): Settings {
  const out: Settings = JSON.parse(JSON.stringify(s));
  for (const pair of pairs) {
    const m = pair.match(/^([a-z_.]+)=(.+)$/i);
    if (!m) throw new Error(`Expected key=value, got "${pair}"`);
    const [key, raw] = [m[1].toLowerCase(), m[2].trim().replace(/[$%]/g, "")];
    const num = (x: string) => {
      const n = Number(x);
      if (!Number.isFinite(n)) throw new Error(`"${x}" is not a number (${key})`);
      return n;
    };
    const parts = key.split(".");
    if (parts.length === 2 && parts[0] in out.exchanges) {
      const ex = out.exchanges[parts[0] as Exchange] as unknown as Record<string, number>;
      if (!(parts[1] in ex)) throw new Error(`Unknown setting ${key} (known: ${Object.keys(ex).join(", ")})`);
      ex[parts[1]] = num(raw);
    } else if (key === "sizes_usd") {
      out.sizes_usd = raw.split(",").map((x) => num(x.trim())).filter((x) => x > 0);
      if (out.sizes_usd.length === 0) throw new Error("sizes_usd needs at least one size");
    } else if (key === "rebalance") {
      out.rebalance = /^(on|true|yes|1)$/i.test(raw);
    } else if (key in out && typeof (out as unknown as Record<string, unknown>)[key] === "number") {
      (out as unknown as Record<string, number>)[key] = num(raw);
    } else {
      throw new Error(`Unknown setting ${key}`);
    }
  }
  return out;
}
