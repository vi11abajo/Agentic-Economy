import { appendFileSync, writeFileSync } from "node:fs";
import { decodeFunctionData, decodeFunctionResult, formatUnits, type Hex } from "viem";
import { PharosMcp, type McpCallRecord } from "@agentic-economy/pharos-mcp";
import {
  abi,
  DEFAULT_CONTRACT,
  EXPLORER,
  groupDigits,
  jsonBigInt,
  readContract,
  requireAddress,
  ROLE_LABELS,
  ZERO,
  type ReadArgs,
  type Report,
} from "./contract.js";

interface Args extends ReadArgs {
  json: boolean;
  trace?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mcp = new PharosMcp("read-contract-state");
  if (args.trace) enableTrace(mcp, args.trace);
  await mcp.connect();
  try {
    const report = await readContract(mcp, args);
    if (args.json) console.log(JSON.stringify(report, jsonBigInt, 2));
    else printReport(report);
  } finally {
    await mcp.close();
  }
}

function printReport(r: Report): void {
  const { token } = r;
  const fmt = (raw: bigint | undefined) =>
    raw === undefined || token.decimals === undefined ? "n/a" : `${groupDigits(formatUnits(raw, token.decimals))} ${token.symbol ?? ""}`.trim();
  const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(16)} ${value ?? "n/a"}`);

  console.log(`\n${token.name ?? "Contract"} on ${r.network.name} (chain ${r.network.chainId})`);
  console.log(`Contract:  ${r.contract}  (${EXPLORER}/address/${r.contract})`);
  console.log(`Read at:   block ${groupDigits(r.block.number.toString())}  (${r.block.timestampUtc.replace("T", " ").replace(".000Z", " UTC")})`);
  console.log(`Source:    Pharos Chain MCP ${r.source}\n`);

  console.log("Token");
  line("Name / symbol", `${token.name ?? "n/a"} / ${token.symbol ?? "n/a"}`);
  line("Decimals", token.decimals);
  line("Total supply", `${fmt(token.totalSupplyRaw)}  (raw ${token.totalSupplyRaw ?? "n/a"})`);
  if (token.currency) line("Pegged to", token.currency);
  if (token.version) line("Code version", token.version);
  if (token.paused !== undefined) line("Status", token.paused ? "PAUSED — transfers are frozen" : "Active — transfers are not paused");

  // A role function that exists but returns the zero address means "role not assigned".
  const roleEntries = Object.entries(r.roles).filter(([, addr]) => addr !== undefined);
  if (roleEntries.length) {
    console.log("\nWho controls it");
    for (const [role, addr] of roleEntries) {
      const shown = addr === ZERO ? "(not assigned)".padEnd(42) : addr;
      console.log(`  ${shown}  ${ROLE_LABELS[role]}`);
    }
  }

  if (r.holders.length) {
    console.log("\nBalances");
    for (const h of r.holders) console.log(`  ${h.address}  ${fmt(h.balance)}`);
  }

  console.log("\nIn plain words");
  const supply = fmt(token.totalSupplyRaw);
  console.log(
    `  At block ${groupDigits(r.block.number.toString())} there were ${supply} in circulation on Pharos.` +
      (token.currency ? ` Each token is meant to be worth 1 ${token.currency}.` : "") +
      (token.paused === false ? " Transfers are working normally." : token.paused ? " Transfers are currently frozen." : ""),
  );
  if (r.roles.implementation) {
    console.log(
      "  The address you interact with is an upgradeable proxy: its rules live in a separate implementation contract,",
      "\n  and the proxy admin can swap that code. Special roles (owner, minter, pauser, blacklister) hold admin powers.",
    );
  }
  console.log(`\n(${r.mcpCalls} Pharos MCP tool calls, contract bytecode ${r.bytecodeBytes} bytes)\n`);
}

/** Writes every MCP tool call (request + raw response) to a JSON Lines file; eth_call lines are decoded. */
function enableTrace(mcp: PharosMcp, file: string): void {
  writeFileSync(file, "");
  let seq = 0;
  mcp.onCall = (record: McpCallRecord) => {
    const line: Record<string, unknown> = { seq: ++seq, ...record };
    try {
      line.response = JSON.parse(record.response);
    } catch {
      // keep the raw text
    }
    if (record.tool === "eth_call") {
      const data = (record.arguments.transaction as { data?: Hex } | undefined)?.data;
      try {
        const call = decodeFunctionData({ abi, data: data as Hex });
        line.function = `${call.functionName}(${(call.args ?? []).join(",")})`;
        const result = (line.response as { result?: Hex })?.result;
        if (result && result !== "0x") {
          line.decoded = decodeFunctionResult({ abi, functionName: call.functionName, data: result } as never);
        }
      } catch {
        // not one of our ABI functions
      }
    }
    appendFileSync(file, `${JSON.stringify(line, jsonBigInt)}\n`);
  };
}

function parseArgs(argv: string[]): Args {
  const args: Args = { contract: DEFAULT_CONTRACT, holders: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === "--contract") args.contract = requireAddress(next());
    else if (a === "--block") args.block = BigInt(next());
    else if (a === "--holder") args.holders.push(requireAddress(next()));
    else if (a === "--json") args.json = true;
    else if (a === "--trace") args.trace = next();
    else if (a === "--help" || a === "-h") {
      console.log("Usage: npm start -- [--contract 0x...] [--block N] [--holder 0x...]... [--json] [--trace file.jsonl]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
