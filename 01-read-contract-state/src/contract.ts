// Reads a contract's state through Pharos Chain MCP at one pinned block. Kept free of I/O so it can be tested
// against a recorded MCP session (see contract.test.ts).
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { McpToolError, PHAROS_MCP_URL } from "@agentic-economy/pharos-mcp";

/** The part of the MCP client the reader needs (PharosMcp implements it). */
export interface McpCaller {
  call<T>(name: string, args?: Record<string, unknown>): Promise<T>;
  readonly calls: number;
}

export interface ReadArgs {
  contract: Address;
  block?: bigint;
  holders: Address[];
}

// USDC issued by Circle on Pharos Pacific Mainnet (docs.pharos.xyz -> Token Registry).
export const DEFAULT_CONTRACT = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const EXPECTED_CHAIN_ID = 1672;
const CONFIRMATIONS = 3n;
export const EXPLORER = "https://www.pharosscan.xyz";
export const ZERO = "0x0000000000000000000000000000000000000000";

export const abi = parseAbi([
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
export const SLOTS = {
  zosImplementation: keccak256(toBytes("org.zeppelinos.proxy.implementation")),
  zosAdmin: keccak256(toBytes("org.zeppelinos.proxy.admin")),
  eip1967Implementation: toSlot(BigInt(keccak256(toBytes("eip1967.proxy.implementation"))) - 1n),
  eip1967Admin: toSlot(BigInt(keccak256(toBytes("eip1967.proxy.admin"))) - 1n),
};

export const ROLE_LABELS: Record<string, string> = {
  owner: "Owner — can reassign every role below",
  masterMinter: "Master Minter — decides who may mint new tokens",
  pauser: "Pauser — can freeze all transfers",
  blacklister: "Blacklister — can block individual addresses",
  rescuer: "Rescuer — can recover tokens sent to the contract by mistake",
  proxyAdmin: "Proxy admin — can upgrade the contract code",
  implementation: "Implementation — the contract code currently in use",
};

export async function readContract(mcp: McpCaller, args: ReadArgs) {
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

export type Report = Awaited<ReturnType<typeof readContract>>;

export function requireAddress(value: string): Address {
  if (!isAddress(value)) throw new Error(`Not an address: ${value}`);
  return getAddress(value);
}

export function toHex(n: bigint): Hex {
  return `0x${n.toString(16)}`;
}

export function toSlot(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

export function groupDigits(value: string): string {
  const [int, frac] = value.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

export function jsonBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

