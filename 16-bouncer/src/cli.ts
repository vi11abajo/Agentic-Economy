#!/usr/bin/env node
// bouncer: stands in front of an agent's on-chain actions. Every request is traced on Pharos mainnet and judged
// against the user's policy by what the transaction would really do; only an ALLOW ever reaches the key.
// Exit codes: 0 allow (or sent), 1 network or other error, 2 bad input or no key, 3 deny (or a broken log).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { formatUnits, isAddress } from "viem";
import { readLog } from "./audit.js";
import { rpcChain, type Chain } from "./chain.js";
import { gate } from "./gate.js";
import { loadPolicy, parsePolicy, type Policy } from "./policy.js";
import { renderVerdict, verdictJson } from "./report.js";
import { USAGE, parseRequest } from "./request.js";
import { sendGated } from "./send.js";
import { displayPath, homeDir, loadAccount } from "./store.js";

export const EXAMPLE_POLICY = {
  name: "my agent's wallet rules",
  wallet: "0x0000000000000000000000000000000000000000",
  time_window: { days: ["mon", "tue", "wed", "thu", "fri"], from: "08:00", to: "20:00", tz: "UTC" },
  contracts: [],
  recipients: [],
  approvals: { spenders: [], unlimited: false },
  spend: { PROS: { per_tx: "0.005", per_day: "0.01" } },
};

const HELP = `bouncer: checks every on-chain action against your policy before it can happen, by tracing what the
transaction would really do on Pharos mainnet. ALLOW or DENY, with the rule that decided; only ALLOW is sent.

  bouncer check <request>          judge it; nothing is signed, no key needed
  bouncer send <request>           judge it again right now, and only on ALLOW sign with the key in .env and send
  bouncer log [--today] [--deny]   every decision so far
  bouncer log --verify             check that nobody edited or removed a line of the log
  bouncer policy                   the rules, in words
  bouncer policy init --wallet <0x...>              start from the example policy
  bouncer policy add-contract|add-recipient|add-spender <0x...>
  bouncer policy remove-contract|remove-recipient|remove-spender <0x...>
  bouncer policy set window <mon,tue,...> <HH:MM-HH:MM> | window off
  bouncer policy set spend.<ASSET>.per_tx|per_day <amount>
  bouncer policy set spend.<ASSET>.token <0x...>   and  spend.<ASSET>.decimals <n>
  bouncer policy set approvals.unlimited true|false
  bouncer setup                    where the data folder is, whether a policy and a key are there
  add --json for machine-readable output

${USAGE}`;

export type Deps = { print: (s: string) => void; home?: string; chain?: Chain; now?: Date };

const LIST_OF: Record<string, "contracts" | "recipients" | "spenders"> = { contract: "contracts", recipient: "recipients", spender: "spenders" };

function explain(p: Policy, home: string): string {
  const lines = [`policy "${p.name}" for wallet ${p.wallet} (${displayPath(join(home, "policy.json"))})`];
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  lines.push(p.timeWindow ? `- time: only ${p.timeWindow.days.join(", ")} from ${hhmm(p.timeWindow.from)} to ${hhmm(p.timeWindow.to)} UTC` : "- time: any time");
  lines.push(p.contracts.length ? `- contracts it may touch, at any depth of the call:\n${p.contracts.map((a) => `    ${a}`).join("\n")}` : "- contracts: none (any call into a contract is refused)");
  lines.push(p.recipients.length ? `- who may receive PROS or tokens (besides the wallet itself and the contracts above):\n${p.recipients.map((a) => `    ${a}`).join("\n")}` : "- recipients: only the wallet itself and the listed contracts");
  lines.push(p.approvals.spenders.length ? `- approvals only to: ${p.approvals.spenders.join(", ")}${p.approvals.unlimited ? " (unlimited allowed)" : " (never unlimited)"}` : "- approvals: none allowed");
  const caps = Object.entries(p.spend);
  if (!caps.length) lines.push("- spending: nothing may leave the wallet");
  for (const [key, c] of caps) lines.push(`- ${key}: at most ${formatUnits(c.perTx, c.decimals)} ${key} per transaction and ${formatUnits(c.perDay, c.decimals)} ${key} per 24 hours${c.token ? ` (token ${c.token})` : ""}`);
  lines.push("- anything else that would leave the wallet is refused");
  return lines.join("\n");
}

/** Edits the policy JSON as text the user owns: change, validate the whole file, and only then write it. */
function editPolicy(home: string, argv: string[], print: Deps["print"]): number {
  const file = join(home, "policy.json");
  if (!existsSync(file)) return print(`no policy yet; start with: bouncer policy init --wallet <0x...>`), 2;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  const [action, ...args] = argv;
  let said = "";
  const list = /^(add|remove)-(contract|recipient|spender)$/.exec(action);
  if (list) {
    const [, verb, what] = list;
    const address = args[0];
    if (!address || !isAddress(address, { strict: false })) return print(`"${address ?? ""}" is not an address`), 2;
    const holder = what === "spender" ? (raw.approvals ??= { spenders: [], unlimited: false }) : raw;
    const key = LIST_OF[what];
    const current: string[] = holder[key] ?? [];
    const has = current.some((a) => a.toLowerCase() === address.toLowerCase());
    if (verb === "add" && has) return print(`${address} is already on the ${key} list`), 0;
    if (verb === "remove" && !has) return print(`${address} isn't on the ${key} list`), 0;
    holder[key] = verb === "add" ? [...current, address] : current.filter((a) => a.toLowerCase() !== address.toLowerCase());
    said = `${verb === "add" ? "added" : "removed"} ${address} ${verb === "add" ? "to" : "from"} ${key}`;
  } else if (action === "set" && args[0] === "window") {
    const before = raw.time_window ? `${raw.time_window.days.join(",")} ${raw.time_window.from}-${raw.time_window.to}` : "any time";
    if (args[1] === "off") delete raw.time_window;
    else {
      const [from, to] = (args[2] ?? "").split("-");
      raw.time_window = { days: (args[1] ?? "").split(",").filter(Boolean), from, to, tz: "UTC" };
    }
    said = `time window: ${before} -> ${args[1] === "off" ? "any time" : `${args[1]} ${args[2]} UTC`}`;
  } else if (action === "set" && args[0] === "approvals.unlimited") {
    raw.approvals ??= { spenders: [], unlimited: false };
    said = `approvals.unlimited: ${raw.approvals.unlimited === true} -> ${args[1] === "true"}`;
    raw.approvals.unlimited = args[1] === "true";
  } else if (action === "set" && /^spend\.[^.]+\.(per_tx|per_day|token|decimals)$/.test(args[0] ?? "")) {
    const [, asset, field] = args[0].split(".");
    raw.spend ??= {};
    raw.spend[asset] ??= {};
    const before = raw.spend[asset][field];
    raw.spend[asset][field] = field === "decimals" ? Number(args[1]) : args[1];
    said = `${args[0]}: ${before ?? "(not set)"} -> ${args[1]}`;
  } else {
    return print(`don't know how to change "${argv.join(" ")}"\n\n${HELP}`), 2;
  }
  const parsed = parsePolicy(raw);
  if ("problems" in parsed) return print(`not saved, the policy would break:\n${parsed.problems.map((p) => `  - ${p}`).join("\n")}`), 2;
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  print(said);
  return 0;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const { print } = deps;
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const [cmd, ...rest] = args;
  const home = deps.home ?? homeDir();
  const now = deps.now ?? new Date();
  const chain = deps.chain ?? rpcChain();

  if (args.some((a) => a.startsWith("--") && /key|mnemonic|secret/i.test(a))) {
    print(`bouncer never takes a key on the command line. Put PRIVATE_KEY=0x... into ${displayPath(join(home, ".env"))} yourself.`);
    return 2;
  }
  if (!cmd || cmd === "--help" || cmd === "help") return print(HELP), cmd ? 0 : 2;

  if (cmd === "setup") {
    mkdirSync(home, { recursive: true });
    const account = loadAccount(home);
    const policy = loadPolicy(home);
    const info = { dataFolder: displayPath(home), policy: "policy" in policy ? `ok, guards ${policy.policy.wallet}` : policy.problems.join("; "), key: account ? `found, for wallet ${account.address}` : `none; the user writes PRIVATE_KEY=0x... into ${displayPath(join(home, ".env"))} themselves` };
    print(json ? JSON.stringify(info, null, 2) : `data folder: ${info.dataFolder}\npolicy: ${info.policy}\nkey: ${info.key}`);
    return 0;
  }

  if (cmd === "policy") {
    if (rest[0] === "init") {
      const file = join(home, "policy.json");
      if (existsSync(file)) return print(`${displayPath(file)} already exists; bouncer never overwrites a policy`), 2;
      const wallet = rest[rest.indexOf("--wallet") + 1];
      if (rest.indexOf("--wallet") < 0 || !wallet || !isAddress(wallet, { strict: false })) return print("which wallet should the policy guard? bouncer policy init --wallet <0x...>"), 2;
      mkdirSync(home, { recursive: true });
      writeFileSync(file, JSON.stringify({ ...EXAMPLE_POLICY, wallet }, null, 2) + "\n");
      print(`wrote ${displayPath(file)} from the example:\n`);
      const loaded = loadPolicy(home);
      if ("policy" in loaded) print(explain(loaded.policy, home));
      return 0;
    }
    if (rest.length) return editPolicy(home, rest, print);
    const loaded = loadPolicy(home);
    if ("problems" in loaded) return print(`the policy can't be used:\n${loaded.problems.map((p) => `  - ${p}`).join("\n")}`), 2;
    print(json ? readFileSync(join(home, "policy.json"), "utf8") : explain(loaded.policy, home));
    return 0;
  }

  if (cmd === "log") {
    const { entries, brokenAt } = readLog(home);
    if (rest.includes("--verify")) {
      if (brokenAt !== null) return print(`the log is broken at line ${brokenAt}: that line was edited, removed or reordered. The ${entries.length} lines before it are intact.`), 3;
      return print(`chain intact (${entries.length} entries)`), 0;
    }
    const since = rest.includes("--today") ? new Date(now.getTime() - 24 * 3600_000) : new Date(0);
    const shown = entries.filter((e) => new Date(e.at) >= since && (!rest.includes("--deny") || e.decision === "deny"));
    if (json) return print(JSON.stringify(shown, null, 2)), 0;
    for (const e of shown) {
      const req = (e.request as { words?: string } | undefined)?.words ?? "";
      if (e.kind === "decision") print(`${e.at}  ${String(e.decision).toUpperCase().padEnd(5)} ${e.rule ? `by ${e.rule}` : ""}  ${req}${e.decision === "deny" ? `\n${" ".repeat(26)}${e.reason}` : ""}`);
      else if (e.kind === "sent") print(`${e.at}  SENT  ${e.txHash}`);
      else if (e.kind === "receipt") print(`${e.at}  ${String(e.status).toUpperCase()}  ${e.txHash} in block ${e.block}`);
      else print(`${e.at}  ERROR ${req}: ${e.message}`);
    }
    if (brokenAt !== null) print(`(the log is broken at line ${brokenAt}; run bouncer log --verify)`);
    return 0;
  }

  if (cmd === "check" || cmd === "send") {
    const loaded = loadPolicy(home);
    const parsed = parseRequest(rest, "policy" in loaded ? loaded.policy : (parsePolicy({ wallet: "0x0000000000000000000000000000000000000000" }) as { policy: Policy }).policy);
    if ("problem" in parsed) return print(parsed.problem), 2;
    if (cmd === "check") {
      const v = await gate(chain, home, parsed.request, { now });
      print(json ? verdictJson(v) : renderVerdict(v));
      return v.decision === "allow" ? 0 : v.decision === "deny" ? 3 : 1;
    }
    const account = loadAccount(home);
    if (!account) return print(`no key yet. The user writes PRIVATE_KEY=0x... into ${displayPath(join(home, ".env"))} themselves; bouncer never asks for it anywhere else.`), 2;
    const out = await sendGated(chain, home, parsed.request, account, { now });
    if (json) print(JSON.stringify({ status: out.status, hash: out.hash, note: out.note, spent: out.spent, verdict: JSON.parse(verdictJson(out.verdict)) }, null, 2));
    else {
      print(renderVerdict(out.verdict));
      if (out.hash) print(`${out.status === "sent" ? "sent" : out.status === "reverted" ? "REVERTED on chain" : "status unknown"}: https://www.pharosscan.xyz/tx/${out.hash}`);
      if (out.note) print(out.note);
    }
    return out.status === "sent" ? 0 : out.status === "denied" ? (out.verdict.decision === "error" ? 1 : 3) : out.status === "reverted" ? 3 : 1;
  }

  print(`unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href || process.argv[1]?.endsWith("bouncer.mjs")) {
  main(process.argv.slice(2), { print: (s) => console.log(s) })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`bouncer: ${(err as Error).message}`);
      process.exit(1);
    });
}
