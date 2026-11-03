#!/usr/bin/env node
// onego: several actions on Pharos mainnet in one transaction from a plain wallet, and nobody gets rights to it.
// Exit codes: 0 done, 1 error, 2 bad plan or no key, 3 refused or reverted.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddress, isAddress, keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import type { Authorization } from "./batch.js";
import { USDC_DECIMALS } from "./book.js";
import { rpcChain, type Chain } from "./chain.js";
import { check, fmt } from "./check.js";
import { parsePlan, toUnits, type Plan } from "./plan.js";
import { recentWallets } from "./recipients.js";
import { renderCheck } from "./report.js";
import { cancel, send } from "./send.js";
import { displayPath, homeDir, loadAccount } from "./store.js";

const HELP = `onego: several actions on Pharos mainnet in ONE transaction, from a plain wallet.
No approve, no delegation: nobody gets rights to the wallet or its money.

  onego recipients --recent <n> [--exclude <addr>]   the n latest plain wallets seen sending in recent blocks
  onego check <plan.json> [--what-if-pros <n>] [--what-if-usdc <n>]
                                                     simulate the whole batch on mainnet; no key needed
  onego send <plan.json>                             check again, sign with the key in .env, send, verify
  onego cancel <send-result.json>                    void USDC signatures a send left unused
  onego setup                                        where the data folder is, and whether a key is there
  add --json to any of them for machine-readable output

A plan: {"wallet": "0x...", "actions": [{"kind": "send_usdc", "to": "0x...", "amount": "0.00001"},
  {"kind": "send_pros", "to": "0x...", "amount": "1"}, {"kind": "buy", "token": "pTACO", "pros": "5"}]}`;

export type Deps = {
  print: (s: string) => void;
  home?: string;
  chain?: Chain;
  now?: bigint;
  simKey?: Hex;
  nonceFor?: (i: number) => Hex;
};

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
// Random 32-byte nonces per run, so two sends never share a USDC authorization.
const randomNonces = (): ((i: number) => Hex) => {
  const seed = generatePrivateKey();
  return (i) => keccak256(toHex(`${seed}:${i}`));
};

function readPlan(file: string | undefined, print: Deps["print"]): Plan | null {
  if (!file || !existsSync(file)) {
    print(`no plan file${file ? ` at ${file}` : ""}; see onego --help`);
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    print(`the plan isn't valid JSON: ${(err as Error).message}`);
    return null;
  }
  const parsed = parsePlan(json);
  if ("problems" in parsed) {
    print(`the plan needs fixing:\n${parsed.problems.map((p) => `  - ${p}`).join("\n")}`);
    return null;
  }
  return parsed.plan;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const { print } = deps;
  const [cmd, arg] = argv;
  const json = argv.includes("--json");
  const home = deps.home ?? homeDir();
  const chain = deps.chain ?? rpcChain();
  const now = deps.now ?? BigInt(Math.floor(Date.now() / 1000));

  if (argv.some((a) => /key|mnemonic/i.test(a) && a.startsWith("--"))) {
    print(`onego never takes a key on the command line. Put PRIVATE_KEY=0x... into ${displayPath(join(home, ".env"))} yourself.`);
    return 2;
  }
  if (!cmd || cmd === "--help" || cmd === "help") {
    print(HELP);
    return cmd ? 0 : 2;
  }

  if (cmd === "setup") {
    mkdirSync(home, { recursive: true });
    const account = loadAccount(home);
    const info = { dataFolder: displayPath(home), envFile: displayPath(join(home, ".env")), wallet: account?.address ?? null };
    print(json ? JSON.stringify(info, null, 2) : `data folder: ${info.dataFolder}\nkey: ${info.wallet ? `found, for wallet ${info.wallet}` : `none yet; the user writes PRIVATE_KEY=0x... into ${info.envFile} themselves`}`);
    return 0;
  }

  if (cmd === "recipients") {
    const n = Number(flag(argv, "--recent") ?? 10);
    const exclude = argv.flatMap((a, i) => (argv[i - 1] === "--exclude" && isAddress(a) ? [getAddress(a)] : []));
    const found = await recentWallets(chain, n, { exclude });
    if (json) print(JSON.stringify(found, big, 2));
    else {
      found.forEach((f) => print(`${f.address}  seen in block ${f.block}`));
      if (found.length < n) print(`only ${found.length} plain wallets in the last 500 blocks`);
    }
    return 0;
  }

  if (cmd === "check") {
    const plan = readPlan(arg, print);
    if (!plan) return 2;
    const pros = flag(argv, "--what-if-pros");
    const usdc = flag(argv, "--what-if-usdc");
    const whatIf = pros || usdc ? { pros: pros ? toUnits(pros, 18) : undefined, usdc: usdc ? toUnits(usdc, USDC_DECIMALS) : undefined } : undefined;
    const { built: _built, ...report } = await check(chain, plan, { now, simKey: deps.simKey ?? generatePrivateKey(), nonceFor: deps.nonceFor ?? randomNonces(), whatIf });
    print(json ? JSON.stringify(report, big, 2) : renderCheck(report));
    return report.sendable ? 0 : 3;
  }

  if (cmd === "send" || cmd === "cancel") {
    const account = loadAccount(home);
    if (!account) {
      print(`no key yet. The user writes PRIVATE_KEY=0x... into ${displayPath(join(home, ".env"))} themselves (a small wallet is best); onego never asks for it anywhere else.`);
      return 2;
    }
    if (cmd === "cancel") {
      if (!arg || !existsSync(arg)) return print("give the send result file that send printed"), 2;
      const saved = JSON.parse(readFileSync(arg, "utf8")) as { unusedAuthorizations: Array<Omit<Authorization, "value" | "validBefore"> & { value: string; validBefore: string }> };
      const auths = saved.unusedAuthorizations.map((a) => ({ ...a, value: BigInt(a.value), validBefore: BigInt(a.validBefore) }));
      if (!auths.length) return print("nothing to cancel: every signature was used"), 0;
      const hash = await cancel(chain, account, auths);
      print(json ? JSON.stringify({ hash }) : `voided ${auths.length} unused USDC signature(s): https://www.pharosscan.xyz/tx/${hash}`);
      return 0;
    }
    const plan = readPlan(arg, print);
    if (!plan) return 2;
    const r = await send(chain, plan, account, { now, nonceFor: deps.nonceFor ?? randomNonces() });
    const sendsDir = join(home, "sends");
    mkdirSync(sendsDir, { recursive: true });
    const resultFile = join(sendsDir, `${r.hash ?? `refused-${now}`}.json`);
    writeFileSync(resultFile, JSON.stringify({ hash: r.hash, status: r.status, results: r.results, unusedAuthorizations: r.unusedAuthorizations, refusals: r.refusals }, big, 2));
    if (json) print(JSON.stringify({ ...r, report: undefined, resultFile }, big, 2));
    else {
      if (r.status === "refused") print(`not sent:\n${r.refusals.map((x) => `  - ${x}`).join("\n")}`);
      else {
        print(`${r.status === "sent_ok" ? "sent" : "REVERTED"}: https://www.pharosscan.xyz/tx/${r.hash}`);
        for (const x of r.results) print(`${String(x.action + 1).padStart(3)}  ${x.label}  ${x.ok ? `ok${x.got ? `, ${fmt(x.got.amount, x.got.decimals)} ${x.got.symbol}` : ""}` : `FAILED: ${x.reason}`}`);
        if (r.unusedAuthorizations.length)
          print(`${r.unusedAuthorizations.length} USDC signature(s) unused, valid until ${new Date(Number(r.unusedAuthorizations[0].validBefore) * 1000).toISOString()}; void them with: onego cancel ${displayPath(resultFile)}`);
      }
      print(`result saved to ${displayPath(resultFile)}`);
    }
    return r.status === "sent_ok" ? 0 : 3;
  }

  print(`unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}


if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href || process.argv[1]?.endsWith("onego.mjs")) {
  main(process.argv.slice(2), { print: (s) => console.log(s) })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`onego: ${(err as Error).message}`);
      process.exit(1);
    });
}
