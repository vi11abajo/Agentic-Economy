import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { McpToolError, PHAROS_MCP_URL, PharosMcp } from "@agentic-economy/pharos-mcp";

// USDC issued by Circle on Pharos Pacific Mainnet (docs.pharos.xyz -> Token Registry).
const DEFAULT_CONTRACT = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const EXPECTED_CHAIN_ID = 1672;
const CONFIRMATIONS = 3n;
const EXPLORER = "https://www.pharosscan.xyz";
const ZERO = "0x0000000000000000000000000000000000000000";

const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function currency() view returns (string)",
  "function version() view returns (string)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function masterMinter() view returns (address)",
  "function pauser() view returns (address)",
  "function blacklister() view returns (address)",
  "function rescuer() view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
]);

type FnName = (typeof abi)[number]["name"];

// Proxy storage slots: ZeppelinOS (used by Circle's FiatTokenProxy) and EIP-1967.
const SLOTS = {
  zosImplementation: keccak256(toBytes("org.zeppelinos.proxy.implementation")),
  zosAdmin: keccak256(toBytes("org.zeppelinos.proxy.admin")),
  eip1967Implementation: toSlot(BigInt(keccak256(toBytes("eip1967.proxy.implementation"))) - 1n),
  eip1967Admin: toSlot(BigInt(keccak256(toBytes("eip1967.proxy.admin"))) - 1n),
};

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner — can reassign every role below",
  masterMinter: "Master Minter — decides who may mint new tokens",
  pauser: "Pauser — can freeze all transfers",
  blacklister: "Blacklister — can block individual addresses",
  rescuer: "Rescuer — can recover tokens sent to the contract by mistake",
  proxyAdmin: "Proxy admin — can upgrade the contract code",
  implementation: "Implementation — the contract code currently in use",
};

interface Args {
  contract: Address;
  block?: bigint;
  holders: Address[];
  json: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mcp = new PharosMcp("read-contract-state");
  await mcp.connect();
  try {
    const report = await readContract(mcp, args);
    if (args.json) console.log(JSON.stringify(report, jsonBigInt, 2));
    else printReport(report);
  } finally {
    await mcp.close();
  }
}

async function readContract(mcp: PharosMcp, args: Args) {
  const chain = await mcp.call<{ chainId: number; latestBlock: string }>("get_chain_info");
  if (chain.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Unexpected chain ${chain.chainId}, expected Pharos Pacific Mainnet (${EXPECTED_CHAIN_ID})`);
  }

  // Pin one block so every value below describes the same moment in time. Stay a few blocks behind the
  // head: the newest block is not always available yet on every RPC node behind the MCP server.
  const blockNumber = args.block ?? BigInt(chain.latestBlock) - CONFIRMATIONS;
  const blockTag = toHex(blockNumber);
  const block = await mcp.call<{ timestamp: Hex; hash: Hex }>("get_block", { block: blockTag });
  const { code } = await mcp.call<{ code: Hex }>("get_code", { address: args.contract, block: blockTag });
  if (!code || code === "0x") throw new Error(`No contract code at ${args.contract} on block ${blockNumber}`);

  const read = async <T>(fn: FnName, fnArgs: readonly unknown[] = []): Promise<T | undefined> => {
    const data = encodeFunctionData({ abi, functionName: fn, args: fnArgs } as never);
    try {
      const { result } = await mcp.call<{ result: Hex }>("eth_call", {
        transaction: { to: args.contract, data },
        block: blockTag,
      });
      if (!result || result === "0x") return undefined;
      return decodeFunctionResult({ abi, functionName: fn, data: result } as never) as T;
    } catch (err) {
      if (err instanceof McpToolError && err.isRevert) return undefined; // function not implemented by this contract
      throw err;
    }
  };
  const slot = async (position: Hex): Promise<Address | undefined> => {
    const { value } = await mcp.call<{ value: Hex }>("get_storage_at", {
      address: args.contract,
      position,
      block: blockTag,
    });
    const addr = getAddress(`0x${value.slice(-40)}`);
    return addr === ZERO ? undefined : addr;
  };

  const [name, symbol, decimals, totalSupply, currency, version, paused] = [
    await read<string>("name"),
    await read<string>("symbol"),
    await read<number>("decimals"),
    await read<bigint>("totalSupply"),
    await read<string>("currency"),
    await read<string>("version"),
    await read<boolean>("paused"),
  ];
  const roles: Record<string, Address | undefined> = {
    owner: await read<Address>("owner"),
    masterMinter: await read<Address>("masterMinter"),
    pauser: await read<Address>("pauser"),
    blacklister: await read<Address>("blacklister"),
    rescuer: await read<Address>("rescuer"),
    proxyAdmin: (await slot(SLOTS.zosAdmin)) ?? (await slot(SLOTS.eip1967Admin)),
    implementation: (await slot(SLOTS.zosImplementation)) ?? (await slot(SLOTS.eip1967Implementation)),
  };
  const holders = [];
  for (const holder of args.holders) {
    holders.push({ address: holder, balance: await read<bigint>("balanceOf", [holder]) });
  }

  return {
    network: { name: "Pharos Pacific Mainnet", chainId: chain.chainId },
    source: PHAROS_MCP_URL,
    contract: getAddress(args.contract),
    bytecodeBytes: (code.length - 2) / 2,
    block: {
      number: blockNumber,
      hash: block.hash,
      timestampUtc: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
    },
    token: { name, symbol, decimals, totalSupplyRaw: totalSupply, currency, version, paused },
    roles,
    holders,
    mcpCalls: mcp.calls,
  };
}

type Report = Awaited<ReturnType<typeof readContract>>;

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
    else if (a === "--help" || a === "-h") {
      console.log("Usage: npm start -- [--contract 0x...] [--block N] [--holder 0x...]... [--json]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function requireAddress(value: string): Address {
  if (!isAddress(value)) throw new Error(`Not an address: ${value}`);
  return getAddress(value);
}

function toHex(n: bigint): Hex {
  return `0x${n.toString(16)}`;
}

function toSlot(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function groupDigits(value: string): string {
  const [int, frac] = value.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

function jsonBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
