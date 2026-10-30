#!/usr/bin/env node
// preflight: simulates a Pharos transaction before it is sent and says GO or NO-GO: success or revert (with the
// reason), the gas it would cost, and what it would change, before and after. `send` simulates again right
// before signing and refuses to send a transaction whose simulation fails.
// Exit codes: 0 GO (or sent as simulated), 1 error, 2 bad input or no key, 3 NO-GO (blocked, nothing sent),
// 4 sent but the result differs from the simulation.
import { join } from "node:path";
import {
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  maxUint256,
  parseAbiItem,
  parseEther,
  parseUnits,
  type AbiFunction,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { ChainMcp, type Chain, type Receipt, type TxRequest } from "./chain.js";
import { DEFAULTS, receiptTokenDeltas, render, simulate, tokenInfo, type Report, type Settings } from "./sim.js";
import { displayPath, homeDir, journal, loadSettings, readJournal, saveSettings, signer } from "./store.js";

class Exit extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export const EXPLORER = "https://www.pharosscan.xyz";
/** Pacific Mainnet tokens from the docs' Token Registry, so a symbol can stand in for the address. */
export const TOKENS: Record<string, Address> = {
  USDC: getAddress("0xc879c018db60520f4355c26ed1a6d572cdac1815"),
  WPROS: getAddress("0x52c48d4213107b20bc583832b0d951fb9ca8f0b0"),
};

const HELP = `preflight: simulate a Pharos transaction before it is sent, and only send it if the simulation passes.

  preflight check <tx> [--from <address>]   simulate: GO or NO-GO, revert reason, gas cost, before -> after
  preflight send <tx>                       the same from your wallet; shows what --yes would send
  preflight send <tx> --yes                 simulate again, then sign and send only if it is GO, and compare
  preflight log [--last N]                  past simulations and sends
  preflight wallet | config [set k=v ...]   the signer's address | gas_buffer_pct, max_fee_multiplier, max_pros_per_tx

  <tx> is one of:
    pros <to> <amount>                      send PROS
    token <token> <to> <amount>             send an ERC-20 (token = address, USDC or WPROS), amount in tokens
    approve <token> <spender> <amount|max>  set an allowance
    call <to> "<fn(type,...)>" [args...]    any contract call by signature, e.g. "deposit()"   [--value PROS]
    raw <to> <data>                         a ready transaction from another tool               [--value PROS]

Exit codes: 0 GO / sent as simulated, 2 bad input, 3 NO-GO (blocked, nothing sent), 4 sent but different.
Data lives in ${displayPath(homeDir())}: config.json, journal.jsonl, .env (the key, you put it there).`;

function parse(argv: string[]) {
  const pos: string[] = [];
  const f = { yes: false, json: false, from: undefined as string | undefined, value: undefined as string | undefined, last: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") f.yes = true;
    else if (a === "--json") f.json = true;
    else if (a === "--from") f.from = argv[++i];
    else if (a === "--value") f.value = argv[++i];
    else if (a === "--last") f.last = Number(argv[++i]);
    else if (a.startsWith("--")) throw new Exit(2, `Unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, f };
}

const addr = (s: string | undefined, what: string): Address => {
  if (!s || !isAddress(s, { strict: false })) throw new Exit(2, `${what} must be an address (got ${s ?? "nothing"})`);
  return getAddress(s);
};
const tokenAddr = (s: string | undefined) => (s && TOKENS[s.toUpperCase()]) || addr(s, "the token or contract");
const pros = (s: string | undefined, what: string) => {
  if (!s || !(Number(s) >= 0)) throw new Exit(2, `${what} must be a number of PROS`);
  return parseEther(s);
};

/** Builds the transaction from the words after check/send, and says in words what it does. */
async function build(chain: Chain, pos: string[], from: Address, value?: string): Promise<{ tx: TxRequest; call: string }> {
  const [kind, ...a] = pos;
  switch (kind) {
    case "pros": {
      const v = pros(a[1], "the amount");
      return { tx: { from, to: addr(a[0], "the recipient"), data: "0x", value: v }, call: `send ${formatEther(v)} PROS` };
    }
    case "token":
    case "approve": {
      const token = tokenAddr(a[0]);
      const t = await tokenInfo(chain, token);
      const who = addr(a[1], kind === "token" ? "the recipient" : "the spender");
      if (!a[2]) throw new Exit(2, `the amount of ${t.symbol} is missing`);
      const unlimited = kind === "approve" && /^(max|unlimited)$/i.test(a[2]);
      const amt = unlimited ? maxUint256 : parseUnits(a[2], t.decimals);
      const fn = kind === "token" ? "transfer" : "approve";
      const data = encodeFunctionData({ abi: [parseAbiItem(`function ${fn}(address,uint256) returns (bool)`)], functionName: fn, args: [who, amt] });
      const words = kind === "token" ? `transfer ${a[2]} ${t.symbol} to ${who}` : `approve ${who} to spend ${unlimited ? "unlimited" : a[2]} ${t.symbol}`;
      return { tx: { from, to: token, data, value: 0n }, call: words };
    }
    case "call": {
      if (!a[1]) throw new Exit(2, 'call needs a function signature, e.g. "transfer(address,uint256)"');
      let fn: AbiFunction;
      try {
        fn = parseAbiItem(`function ${a[1].replace(/^function\s+/, "")}`) as AbiFunction;
      } catch {
        throw new Exit(2, `can't read the signature "${a[1]}"`);
      }
      const args = a.slice(2);
      if (args.length !== fn.inputs.length) throw new Exit(2, `${fn.name} takes ${fn.inputs.length} argument(s), got ${args.length}`);
      const vals = fn.inputs.map((inp, i) => (inp.type === "address" ? addr(args[i], inp.name || `argument ${i + 1}`) : /^u?int/.test(inp.type) ? BigInt(args[i]) : inp.type === "bool" ? args[i] === "true" : args[i]));
      const v = value ? pros(value, "--value") : 0n;
      return { tx: { from, to: tokenAddr(a[0]), data: encodeFunctionData({ abi: [fn], functionName: fn.name, args: vals }), value: v }, call: `${fn.name}(${args.join(", ")})${v ? ` with ${formatEther(v)} PROS` : ""}` };
    }
    case "raw": {
      if (!a[1] || !isHex(a[1])) throw new Exit(2, "raw needs the call data as 0x... hex");
      const v = value ? pros(value, "--value") : 0n;
      return { tx: { from, to: tokenAddr(a[0]), data: a[1] as Hex, value: v }, call: `raw call, selector ${a[1].slice(0, 10)}${v ? ` with ${formatEther(v)} PROS` : ""}` };
    }
    default:
      throw new Exit(2, `What transaction? pros | token | approve | call | raw (see preflight --help)`);
  }
}

function loadKey(home: string): Account | null {
  try {
    return signer(home);
  } catch (e) {
    throw new Exit(2, (e as Error).message);
  }
}

async function waitReceipt(chain: Chain, hash: Hex, ms: number): Promise<Receipt | null> {
  const until = Date.now() + ms;
  for (;;) {
    const r = await chain.receipt(hash);
    if (r || Date.now() >= until) return r;
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/** What really happened against what the simulation said: status, gas, and every token balance change. */
async function compare(chain: Chain, r: Report, rc: Receipt): Promise<{ lines: string[]; same: boolean }> {
  const lines: string[] = [];
  let same = true;
  const line = (ok: boolean, what: string) => {
    if (!ok) same = false;
    lines.push(`  ${ok ? "AS SIMULATED" : "DIFFERENT   "}  ${what}`);
  };
  line(rc.status === "success", `status ${rc.status}`);
  const g = r.gas!;
  lines.push(`  gas used ${rc.gasUsed.toLocaleString("en-US")} (estimate ${g.estimate.toLocaleString("en-US")}, limit ${g.limit.toLocaleString("en-US")}), paid ${formatEther(rc.gasUsed * rc.effectiveGasPrice)} PROS`);
  const actual = receiptTokenDeltas(rc.logs);
  for (const c of r.changes.filter((x) => x.kind === "token")) {
    const k = `${c.token!.address.toLowerCase()}|${c.holder.toLowerCase()}`;
    const want = c.after - c.before;
    const got = actual.get(k) ?? 0n;
    const fmt = (x: bigint) => `${x >= 0n ? "+" : ""}${formatUnits(x, c.token!.decimals)}`;
    line(got === want, `${c.token!.symbol} ${c.holder}: ${fmt(got)} (simulated ${fmt(want)})`);
  }
  const before = await chain.balance(r.tx.from, rc.block - 1n);
  const after = await chain.balance(r.tx.from, rc.block);
  const sent = r.tx.to.toLowerCase() === r.tx.from.toLowerCase() ? 0n : r.tx.value;
  lines.push(`  PROS of the sender: ${formatEther(after - before)} (value ${formatEther(sent)} + gas ${formatEther(before - after - sent)})`);
  return { lines, same };
}

export interface Deps {
  home: string;
  chain: () => Promise<Chain>;
  out: (s: string) => void;
}

export async function main(argv: string[], deps?: Partial<Deps>): Promise<number> {
  const d: Deps = { home: deps?.home ?? homeDir(), chain: deps?.chain ?? (() => ChainMcp.open()), out: deps?.out ?? ((s) => console.log(s)) };
  const [cmd, ...rest] = argv;
  try {
    const { pos, f } = parse(rest);
    switch (cmd) {
      case undefined:
      case "help":
      case "--help": {
        d.out(HELP);
        const a = loadKey(d.home);
        d.out(a ? `Signing key: found (signer ${a.address}).` : `Signing key: none yet. The user puts PRIVATE_KEY=0x... into ${displayPath(join(d.home, ".env"))} themselves.`);
        return 0;
      }

      case "check":
      case "send": {
        const account = loadKey(d.home);
        if (cmd === "send" && !account) throw new Exit(2, `No key in ${displayPath(join(d.home, ".env"))}. The user puts PRIVATE_KEY=0x... there themselves; never paste it into a chat.`);
        if (cmd === "send" && f.from) throw new Exit(2, "send always uses the key's own address; --from is for check");
        const from = f.from ? addr(f.from, "--from") : account?.address;
        if (!from) throw new Exit(2, "check needs --from <address> when there is no key");
        const settings = loadSettings(d.home);
        const chain = await d.chain();
        try {
          const { tx, call } = await build(chain, pos, from, f.value);
          const r = await simulate(chain, tx, { settings, call });
          journal(d.home, { event: cmd === "send" && f.yes ? "send-check" : "check", block: r.block.toString(), from, to: tx.to, call, verdict: r.verdict, revert: r.revert, reasons: r.reasons });
          if (f.json) d.out(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
          else d.out(render(r, { [from.toLowerCase()]: "you" }));
          if (r.verdict === "NO-GO") {
            if (cmd === "send") d.out("\nBLOCKED: the simulation failed, so nothing was signed or sent.");
            return 3;
          }
          if (cmd === "check") return 0;
          if (!f.yes) {
            d.out("\nNot sent. After the user says yes, run the same command with --yes: it simulates again first.");
            return 0;
          }
          // Signed only now, with the gas limit and fee from the simulation that just passed.
          const g = r.gas!;
          const raw = await account!.signTransaction!({ chainId: 1672, type: "eip1559", to: tx.to, data: tx.data, value: tx.value, gas: g.limit, maxFeePerGas: g.maxFee, maxPriorityFeePerGas: g.priority, nonce: await chain.nonce(from) });
          let hash = keccak256(raw);
          let broadcastError: string | undefined;
          try {
            hash = await chain.sendRaw(raw);
          } catch (e) {
            broadcastError = (e as Error).message.split("\n")[0];
          }
          const rc = await waitReceipt(chain, hash, broadcastError ? 20_000 : 90_000);
          if (!rc) throw new Exit(1, broadcastError ? `broadcast failed and the tx isn't on chain: ${broadcastError}` : `${hash} not mined within 90s; check it before trying again`);
          const cmp = await compare(chain, r, rc);
          d.out([`\nSENT  ${EXPLORER}/tx/${hash}  (block ${rc.block.toLocaleString("en-US")})`, ...cmp.lines, cmp.same ? "RESULT  as simulated" : "RESULT  different from the simulation"].join("\n"));
          journal(d.home, { event: "sent", hash, block: rc.block.toString(), status: rc.status, gasUsed: rc.gasUsed.toString(), asSimulated: cmp.same });
          return cmp.same ? 0 : 4;
        } finally {
          await chain.close();
        }
      }

      case "log": {
        const rows = readJournal(d.home).slice(-f.last);
        if (!rows.length) return d.out("Nothing simulated yet."), 0;
        for (const e of rows) {
          const at = String(e.at).replace("T", " ").slice(0, 19);
          d.out(e.event === "sent" ? `${at}  SENT     ${e.hash} ${e.status}${e.asSimulated ? ", as simulated" : ", DIFFERENT"}` : `${at}  ${String(e.verdict).padEnd(6)}   ${e.call}${e.revert ? `: ${e.revert}` : ""}`);
        }
        return 0;
      }

      case "wallet": {
        const a = loadKey(d.home);
        if (!a) throw new Exit(2, `No key in ${displayPath(join(d.home, ".env"))}.`);
        const chain = await d.chain();
        const bal = await chain.balance(a.address).finally(() => chain.close());
        d.out(`signer ${a.address}\nPROS   ${formatEther(bal)}`);
        return 0;
      }

      case "config": {
        const s = loadSettings(d.home);
        if (pos[0] !== "set") return d.out(JSON.stringify(s, null, 2)), 0;
        for (const kv of pos.slice(1)) {
          const [k, v] = kv.split("=");
          if (!(k in DEFAULTS) || !(Number(v) >= 0)) throw new Exit(2, `Unknown setting or bad value: ${kv}. Settings: ${Object.keys(DEFAULTS).join(", ")}`);
          (s as unknown as Record<string, number>)[k as keyof Settings] = Number(v);
        }
        d.out(`saved to ${displayPath(saveSettings(d.home, s))}\n${JSON.stringify(s, null, 2)}`);
        return 0;
      }

      default:
        throw new Exit(2, `Unknown command "${cmd}". Run preflight --help.`);
    }
  } catch (e) {
    if (e instanceof Exit) {
      console.error(e.message);
      return e.code;
    }
    console.error(`preflight: ${String((e as Error).message).split("\n")[0]}`);
    return 1;
  }
}

const isMain = process.argv[1] && /(cli\.js|preflight(\.mjs)?)$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
