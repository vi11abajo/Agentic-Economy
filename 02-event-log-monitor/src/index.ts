import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { PHAROS_MCP_URL, PharosMcp } from "@agentic-economy/pharos-mcp";
import {
  BOUGHT,
  fmt,
  hex,
  KEEP_SEEN,
  MAX_LOG_RANGE,
  MARKET_CREATED_TOPIC,
  NATIVE,
  num,
  pickNewTrades,
  PROSPER_FACTORY,
  short,
  SOLD,
  windowEnd,
  type Config,
  type Market,
  type RpcLog,
  type State,
  type Trade,
} from "./curve.js";

const viewAbi = parseAbi([
  "function pToken() view returns (address)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const C = { cobalt: "\x1b[38;2;30;43;250m", muted: "\x1b[38;2;107;107;107m", green: "\x1b[38;2;5;150;105m", red: "\x1b[38;2;220;38;38m", bold: "\x1b[1m", reset: "\x1b[0m" };

let color = process.stdout.isTTY ?? false;
const paint = (c: keyof typeof C, s: string) => (color ? `${C[c]}${s}${C.reset}` : s);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv.shift()! : "watch";
  const opt = parseOptions(argv);
  if (opt.color !== undefined) color = opt.color;

  const mcp = new PharosMcp("prosper-curve-monitor");
  await mcp.connect();
  try {
    if (cmd === "add") await addMarket(mcp, opt);
    else if (cmd === "discover") await discover(mcp, opt);
    else if (cmd === "watch") await watch(mcp, opt);
    else throw new Error(`Unknown command: ${cmd} (use watch | add | discover)`);
  } finally {
    await mcp.close();
  }
}

// ---------------------------------------------------------------------------------------------- watch

async function watch(mcp: PharosMcp, opt: Options): Promise<void> {
  const config = loadConfig(opt.config);
  if (!config.markets.length) throw new Error(`No markets in ${opt.config}. Add one: npm run add -- 0xMARKET`);
  const interval = (opt.interval ?? config.intervalSec ?? 3) * 1000;
  const confirmations = BigInt(opt.confirmations ?? config.confirmations ?? 3);

  const chain = await mcp.call<{ chainId: number; latestBlock: string }>("get_chain_info");
  const markets = new Map<string, Market>();
  for (const m of config.markets) {
    const resolved = await resolveMarket(mcp, m.market);
    markets.set(resolved.market.toLowerCase(), { ...resolved, name: m.name ?? resolved.name, minPros: m.minPros });
  }

  const ids = [...markets.keys()].sort();
  const saved = loadState(opt.state, ids);
  let next = opt.fromBlock ?? (saved ? BigInt(saved.nextBlock) : BigInt(chain.latestBlock) - confirmations);
  const seen = new Set<string>(saved?.seen ?? []);

  console.log(paint("cobalt", paint("bold", `Watching ${markets.size} Prosper curve(s) for buys and sells`)));
  for (const m of markets.values()) {
    console.log(paint("muted", `  ${m.symbol.padEnd(10)} market ${m.market} · pToken ${m.pToken}${m.minPros ? ` · ≥ ${m.minPros} ${NATIVE}` : ""}`));
  }
  console.log(paint("muted", `chain ${chain.chainId} · Pharos Chain MCP ${PHAROS_MCP_URL} · from block ${fmt(next)}${saved && opt.fromBlock === undefined ? " (resumed)" : ""} · poll ${interval / 1000}s · ${confirmations} confirmations · Ctrl+C to stop\n`));

  let reportedTotal = 0;
  let stopping = false;
  // In a terminal the idle status is one line updated in place; in logs/pipes it is one line per poll.
  let idleShown = false;
  const clearIdle = () => {
    if (idleShown) process.stdout.write("\r\x1b[2K");
    idleShown = false;
  };
  process.on("SIGINT", () => {
    stopping = true;
  });

  while (!stopping) {
    const head = BigInt((await mcp.call<{ blockNumber: string }>("get_block_number")).blockNumber);
    const safe = head - confirmations;
    let reported = 0;
    while (next <= safe && !stopping) {
      const to = windowEnd(next, safe);
      // One MCP query covers every configured curve: address list + (Bought OR Sold).
      const logs = await mcp.call<RpcLog[]>("get_logs", {
        address: ids,
        topics: [[BOUGHT, SOLD]],
        fromBlock: hex(next),
        toBlock: hex(to),
      });
      for (const trade of pickNewTrades(logs, markets, seen)) {
        reported++;
        reportedTotal++;
        appendFileSync(opt.log, `${JSON.stringify({ n: reportedTotal, ...trade })}
`);
        clearIdle();
        printTrade(reportedTotal, trade);
        if (opt.maxEvents && reportedTotal >= opt.maxEvents) stopping = true;
        if (stopping) break;
      }
      next = to + 1n;
      saveState(opt.state, { markets: ids, nextBlock: next.toString(), seen: [...seen].slice(-KEEP_SEEN) });
    }
    if (!stopping && reported === 0) {
      if (color) {
        process.stdout.write(`\r\x1b[2K${paint("muted", `  · block ${fmt(safe)} · watching, no new trades yet…`)}`);
        idleShown = true;
      } else process.stdout.write(`  · block ${fmt(safe)} — no new trades\n`);
    }
    if (!stopping) await sleep(interval);
  }
  clearIdle();
  console.log(paint("green", `\n✓ stopped · ${reportedTotal} trade(s) reported · resumes at block ${fmt(next)} · ${mcp.calls} MCP calls`));
}

function printTrade(n: number, t: Trade): void {
  const side = t.side === "BUY" ? paint("green", paint("bold", "BUY ")) : paint("red", paint("bold", "SELL"));
  const time = t.time ? `${t.time.slice(11, 19)} UTC` : "";
  const what = t.side === "BUY"
    ? `paid ${num(t.pros)} ${NATIVE} → got ${num(t.tokens)} ${t.token}`
    : `sold ${num(t.tokens)} ${t.token} → got ${num(t.pros)} ${NATIVE}`;
  console.log(`${paint("muted", paint("bold", `#${n}`))} ${side} ${paint("cobalt", paint("bold", t.token))}  ${paint("muted", `block ${fmt(BigInt(t.block))} · ${time}`)}`);
  console.log(`    ${short(t.trader)}  ${what}`);
  console.log(paint("muted", `    price ${t.price.toPrecision(4)} ${NATIVE}/${t.token} · fee ${num(t.fee)} ${NATIVE} · tx ${t.tx}`));
}

// ------------------------------------------------------------------------------------------ add / discover

async function addMarket(mcp: PharosMcp, opt: Options): Promise<void> {
  const addr = opt.positional[0];
  if (!addr || !isAddress(addr)) throw new Error("Usage: npm run add -- 0xMARKET [--name \"label\"] [--min 10]");
  const m = await resolveMarket(mcp, addr);
  const config = existsSync(opt.config) ? loadConfig(opt.config) : { intervalSec: 3, confirmations: 3, markets: [] };
  if (config.markets.some((x) => x.market.toLowerCase() === m.market.toLowerCase())) {
    console.log(`${m.symbol} (${m.market}) is already in ${opt.config}`);
    return;
  }
  config.markets.push({ name: opt.name ?? m.name, market: m.market, ...(opt.min ? { minPros: opt.min } : {}) });
  writeFileSync(opt.config, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Added ${m.symbol} "${m.name}" · market ${m.market} · pToken ${m.pToken} → ${opt.config} (${config.markets.length} markets)`);
}

async function discover(mcp: PharosMcp, opt: Options): Promise<void> {
  const head = BigInt((await mcp.call<{ blockNumber: string }>("get_block_number")).blockNumber);
  const blocks = BigInt(opt.blocks ?? 30000);
  const from = head - blocks;
  console.log(paint("muted", `Prosper markets created in the last ${fmt(blocks)} blocks (ProsperFactory ${PROSPER_FACTORY}, via Pharos Chain MCP):`));
  let found = 0;
  for (let a = from; a <= head; a += MAX_LOG_RANGE) {
    const b = windowEnd(a, head);
    const logs = await mcp.call<RpcLog[]>("get_logs", {
      address: PROSPER_FACTORY,
      topics: [MARKET_CREATED_TOPIC],
      fromBlock: hex(a),
      toBlock: hex(b),
    });
    for (const log of logs) {
      const market = getAddress(`0x${log.data.slice(26, 66)}`);
      const vault = getAddress(`0x${log.topics[1].slice(26)}`);
      const m = await resolveMarket(mcp, market);
      found++;
      console.log(`  ${m.symbol.padEnd(10)} ${m.name.padEnd(24)} market ${market}  (vault …${vault.slice(-6).toLowerCase()}, block ${fmt(BigInt(log.blockNumber))})`);
    }
  }
  console.log(paint("muted", `${found} found. Add one with: npm run add -- 0xMARKET`));
}

async function resolveMarket(mcp: PharosMcp, market: string): Promise<Market & { name: string }> {
  const addr = getAddress(market);
  const call = async <T>(to: Address, fn: "pToken" | "symbol" | "name" | "decimals"): Promise<T> => {
    const { result } = await mcp.call<{ result: Hex }>("eth_call", {
      transaction: { to, data: encodeFunctionData({ abi: viewAbi, functionName: fn }) },
      block: "latest",
    });
    if (!result || result === "0x") throw new Error(`${to} has no ${fn}() — is it a Prosper market?`);
    return decodeFunctionResult({ abi: viewAbi, functionName: fn, data: result }) as T;
  };
  const pToken = getAddress(await call<string>(addr, "pToken"));
  return {
    market: addr,
    pToken,
    symbol: await call<string>(pToken, "symbol"),
    name: await call<string>(pToken, "name"),
    decimals: Number(await call<number>(pToken, "decimals")),
  };
}

// -------------------------------------------------------------------------------------------- helpers

interface Options {
  config: string;
  state: string;
  log: string;
  interval?: number;
  confirmations?: number;
  fromBlock?: bigint;
  maxEvents?: number;
  blocks?: number;
  name?: string;
  min?: number;
  color?: boolean;
  positional: string[];
}

function parseOptions(argv: string[]): Options {
  const o: Options = { config: "markets.json", state: ".monitor-state.json", log: "trades.jsonl", positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`Missing value for ${a}`);
      return x;
    };
    if (a === "--config") o.config = v();
    else if (a === "--state") o.state = v();
    else if (a === "--log") o.log = v();
    else if (a === "--interval") o.interval = Number(v());
    else if (a === "--confirmations") o.confirmations = Number(v());
    else if (a === "--from-block") o.fromBlock = BigInt(v());
    else if (a === "--max-events") o.maxEvents = Number(v());
    else if (a === "--blocks") o.blocks = Number(v());
    else if (a === "--name") o.name = v();
    else if (a === "--min") o.min = Number(v());
    else if (a === "--color") o.color = true;
    else if (a === "--no-color") o.color = false;
    else if (a === "--help" || a === "-h") {
      console.log([
        "npm start                          watch every curve in markets.json (resumes where it stopped)",
        "npm start -- --from-block N        replay from block N, then keep watching",
        "npm run add -- 0xMARKET [--name X] [--min 10]   add a curve (checked via MCP)",
        "npm run discover -- [--blocks 30000]           list recently created Prosper curves",
      ].join("\n"));
      process.exit(0);
    } else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
    else o.positional.push(a);
  }
  return o;
}

function loadConfig(file: string): Config {
  if (!existsSync(file)) throw new Error(`Config not found: ${file}`);
  const c = JSON.parse(readFileSync(file, "utf8")) as Config;
  for (const m of c.markets) if (!isAddress(m.market)) throw new Error(`Bad market address in ${file}: ${m.market}`);
  return c;
}

function loadState(file: string, ids: string[]): State | undefined {
  if (!existsSync(file)) return undefined;
  const s = JSON.parse(readFileSync(file, "utf8")) as State;
  // A different set of markets starts a fresh cursor (new markets would otherwise miss history).
  return s.markets.join(",") === ids.join(",") ? s : undefined;
}

function saveState(file: string, s: State): void {
  writeFileSync(file, JSON.stringify(s));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
