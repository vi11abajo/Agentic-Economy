#!/usr/bin/env node
// kickback: a bonus cashback draw for people who recently bought Prosper tokens on Pharos. The list and the rule
// go on chain first; the hash of a block that didn't exist yet picks the winners; anyone can re-check it later.
// Exit codes: 0 done (or verify MATCH), 1 network or other error, 2 bad input, a stop before the commit, or a
// verify that doesn't match.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { formatUnits, type Hex, type LocalAccount } from "viem";
import { mcpChain, short, type CallLog, type Chain } from "./chain.js";
import { PROS_TOKEN } from "./commit.js";
import { StopBeforeCommit, resumeDraw, runDraw } from "./flow.js";
import { PharosMcp } from "./mcp.js";
import { DEFAULTS, type DrawParams, type Token } from "./params.js";
import { USDC, type Sleep } from "./pay.js";
import { displayPath, homeDir, loadAccount, loadCaps } from "./store.js";
import { verifyDraw } from "./verify.js";

const HELP = `kickback: bonus cashback for people who recently bought Prosper tokens on Pharos, drawn fairly.
The list of buyers and the rule are written on chain first; the hash of a later block picks the winners.

  kickback draw [--pool 30] [--winners 3] [--amount 0.00001] [--token USDC|PROS] [--delay 5] [--dry]
      find the last <pool> buyers, commit them on chain, wait <delay> blocks, pick <winners>, pay each <amount>
      --dry stops before anything is signed
  kickback draw --resume <commitTx>      finish a draw that was interrupted (never pays anyone twice)
  kickback verify <commitTx> [payoutTx...]   redo the draw from the chain alone and check the payouts
      (PROS payouts leave no logs, so pass their tx hashes; USDC ones are found near the target block,
      pass their hashes too if the draw was resumed much later)
  kickback setup                         data folder, wallet, balances and the caps

Caps live in config.json in the data folder and only change when you edit that file.`;

type Parsed = { cmd: "draw" | "verify" | "setup" | "help"; params: DrawParams; dry: boolean; resume?: Hex; commitTx?: Hex; payoutTxs: Hex[] };
const isHash = (s: string | undefined): s is Hex => !!s && /^0x[0-9a-fA-F]{64}$/.test(s);

export function parseArgs(argv: string[]): Parsed | { error: string } {
  const [cmd = "help", ...rest] = argv;
  const out: Parsed = { cmd: "help", params: { ...DEFAULTS }, dry: false, payoutTxs: [] };
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return out;
  if (cmd === "setup") return { ...out, cmd };
  if (cmd === "verify") {
    if (!isHash(rest[0])) return { error: "verify needs the commit tx hash (0x + 64 hex characters)" };
    const bad = rest.slice(1).find((h) => !isHash(h));
    if (bad) return { error: `"${bad}" is not a tx hash` };
    return { ...out, cmd, commitTx: rest[0], payoutTxs: rest.slice(1) as Hex[] };
  }
  if (cmd !== "draw") return { error: `unknown command "${cmd}"; try: kickback help` };
  out.cmd = "draw";
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    const number = () => (value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN);
    switch (flag) {
      case "--dry":
        out.dry = true;
        continue;
      case "--pool":
        out.params.pool = number();
        break;
      case "--winners":
        out.params.winners = number();
        break;
      case "--delay":
        out.params.delay = number();
        break;
      case "--amount":
        out.params.amount = value ?? "";
        break;
      case "--token":
        out.params.token = (value ?? "").toUpperCase() as Token;
        break;
      case "--resume":
        if (!isHash(value)) return { error: "--resume needs the commit tx hash (0x + 64 hex characters)" };
        out.resume = value;
        break;
      default:
        return { error: `unknown flag "${flag}"; try: kickback help` };
    }
    if (value === undefined) return { error: `${flag} needs a value` };
    i++;
  }
  return out;
}

export type Deps = { print: (s: string) => void; home?: string; chain?: Chain; account?: LocalAccount | null; sleep?: Sleep };

export async function main(argv: string[], deps: Deps): Promise<number> {
  const { print } = deps;
  const args = parseArgs(argv);
  if ("error" in args) return print(args.error), 2;
  if (args.cmd === "help") return print(HELP), 0;

  const home = deps.home ?? homeDir();
  const live = deps.chain ? null : await connect(print);
  const chain = deps.chain ?? live!.chain;
  try {
    if (args.cmd === "verify") return await verifyCommand(chain, args.commitTx!, args.payoutTxs, print);
    const account = deps.account !== undefined ? deps.account : loadAccount(home);
    if (!account) {
      print(`no key yet. The user writes PRIVATE_KEY=0x... into ${displayPath(join(home, ".env"))} themselves; kickback never asks for it anywhere else.`);
      return 2;
    }
    const caps = loadCaps(home);
    if (args.cmd === "setup") return await setupCommand(chain, account, home, caps, print);
    const drawDeps = { chain, account, caps, home, say: print, sleep: deps.sleep };
    try {
      if (args.resume) await resumeDraw(drawDeps, args.resume);
      else await runDraw(drawDeps, args.params, { dry: args.dry });
      return 0;
    } catch (err) {
      if (err instanceof StopBeforeCommit) return print(`stopped before anything was signed: ${err.message}`), 2;
      throw err;
    }
  } catch (err) {
    print(`error: ${(err as Error).message}`);
    print(`if a commit already went out, nothing is lost: kickback draw --resume <commitTx> picks it up (the draws folder in ${displayPath(home)} has it)`);
    return 1;
  } finally {
    await live?.mcp.close();
  }
}

async function connect(print: (s: string) => void) {
  const mcp = new PharosMcp("kickback");
  await mcp.connect();
  // Every Chain MCP call scrolls by as it happens, so you can watch the data move.
  const chain = mcpChain(mcp, (c: CallLog) => print(`    · [${c.step}] ${c.tool} ${c.args}`.trimEnd() + `  ${c.ms} ms`));
  return { mcp, chain };
}

async function setupCommand(chain: Chain, account: LocalAccount, home: string, caps: ReturnType<typeof loadCaps>, print: (s: string) => void) {
  chain.step("setup");
  const me = account.address;
  const pros = await chain.balance(me);
  const usdc = BigInt(await chain.call(USDC, `0x70a08231${me.slice(2).toLowerCase().padStart(64, "0")}`));
  print(`data folder  ${displayPath(home)}`);
  print(`wallet       ${me} (key in .env, never shown)`);
  print(`balances     ${formatUnits(pros, 18)} PROS, ${formatUnits(usdc, 6)} USDC`);
  print(`caps         ${caps.max_total_usdc} USDC and ${caps.max_total_pros} PROS per draw, look-back ${caps.lookback_blocks} blocks (config.json)`);
  return 0;
}

async function verifyCommand(chain: Chain, commitTx: Hex, payoutTxs: Hex[], print: (s: string) => void) {
  const v = await verifyDraw(chain, commitTx, payoutTxs);
  const token = v.commit.token === PROS_TOKEN ? "PROS" : "USDC";
  const amount = formatUnits(v.commit.amountRaw, token === "PROS" ? 18 : 6);
  print(`commit   ${commitTx} by ${v.sender}, mined in block ${v.commitBlock}`);
  print(`rule     ${v.commit.winners} winners out of ${v.commit.pool.length} buyers (as of block ${v.commit.snapshot}), ${amount} ${token} each, picked by block ${v.commitBlock} + ${v.commit.delay}`);
  print(`target   block ${v.target.block}, hash ${v.target.hash}`);
  print(`seed     keccak256(hash, commitTx) = ${v.seed}`);
  v.payouts.forEach((p, i) => print(`  ${i + 1}. ${p.winner}  ${p.note}${p.tx ? `  ${short(p.tx)}` : ""}`));
  if (v.match) {
    print("MATCH: the winners follow from the committed list and the block hash, and each one was paid");
    return 0;
  }
  print(`DIFFERENT: ${v.firstDifference}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { print: (s) => console.log(s) }).then((code) => (process.exitCode = code));
}
