// Where Prosper lives. The addresses come from Prosper's own API, but we only trust them after the chain agrees:
// the factory must be the one whose MarketCreated events we watch, and the market beacon must be the beacon that
// real markets actually point at. If Prosper moves something, we want a loud error, not a quiet wrong answer.
import { getAddress, parseAbi, type Address, type Hex } from "viem";
import { client } from "./chain.js";

export const DEPLOYMENT_URL = "https://api.pros-per.xyz/api/v1/deployment";
export const PROSPER_FACTORY: Address = "0xEfdbb0eA7647B0e21AEf7A3b7a5D6A632c3116C8";
export const USDC: Address = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
// The pBOT market, a real one we checked by hand in recon. Its beacon slot tells us which beacon markets use.
export const KNOWN_MARKET: Address = "0x94228eb493173e75a12e76e667bfe9b0939aae64";
// EIP-1967 beacon slot: keccak256("eip1967.proxy.beacon") - 1
const BEACON_SLOT: Hex = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const beaconAbi = parseAbi(["function implementation() view returns (address)"]);

export interface ProtocolMap {
  factory: Address;
  marketBeacon: Address;
  marketImpl: Address;
  usdc: Address;
  deployment: Record<string, Address>;
  block: bigint;
}

export class ProtocolDrift extends Error {
  constructor(public field: string, detail: string) {
    super(`Prosper map drifted at ${field}: ${detail}`);
    this.name = "ProtocolDrift";
  }
}

async function fetchDeployment(): Promise<Record<string, Address>> {
  const res = await fetch(DEPLOYMENT_URL);
  if (!res.ok) throw new Error(`Prosper deployment API answered ${res.status}`);
  const body = (await res.json()) as { data: Record<string, unknown> };
  const out: Record<string, Address> = {};
  for (const [k, v] of Object.entries(body.data)) {
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) out[k] = getAddress(v);
  }
  return out;
}

/** Holds the API's addresses up against the chain at one block and returns the checked map. */
export async function checkMap(d: Record<string, Address>, at?: bigint): Promise<ProtocolMap> {
  const block = at ?? (await client.getBlockNumber({ cacheTime: 0 }));
  for (const field of ["prosperFactory", "marketBeacon", "usdc"]) {
    if (!d[field]) throw new ProtocolDrift(field, "missing from the API");
  }
  if (d.prosperFactory.toLowerCase() !== PROSPER_FACTORY.toLowerCase())
    throw new ProtocolDrift("prosperFactory", `API says ${d.prosperFactory}, we watch ${PROSPER_FACTORY}`);
  if (d.usdc.toLowerCase() !== USDC.toLowerCase()) throw new ProtocolDrift("usdc", `API says ${d.usdc}`);

  const raw = await client.getStorageAt({ address: KNOWN_MARKET, slot: BEACON_SLOT, blockNumber: block });
  const beaconOnChain = getAddress(`0x${(raw ?? "0x").slice(-40)}`);
  if (beaconOnChain.toLowerCase() !== d.marketBeacon.toLowerCase())
    throw new ProtocolDrift("marketBeacon", `API says ${d.marketBeacon}, markets point at ${beaconOnChain}`);

  for (const [field, addr] of Object.entries(d)) {
    const code = await client.getCode({ address: addr, blockNumber: block });
    if (!code || code === "0x") throw new ProtocolDrift(field, `${addr} has no code at block ${block}`);
  }
  const marketImpl = await client.readContract({
    address: d.marketBeacon, abi: beaconAbi, functionName: "implementation", blockNumber: block,
  });
  return { factory: d.prosperFactory, marketBeacon: d.marketBeacon, marketImpl, usdc: d.usdc, deployment: d, block };
}

export async function loadProtocol(): Promise<ProtocolMap> {
  return checkMap(await fetchDeployment());
}
