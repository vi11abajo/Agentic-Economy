// .eth names. Pharos has no name service of its own (no ENS registry there, nothing in the docs), so a name can
// only mean what ENS on Ethereum says. That is where it gets interesting: the task's own example, alice.eth,
// points to a Safe on Ethereum, and that Safe was never deployed on Pharos. Money sent to it there lands at an
// address whose owners may have no way to touch it. So knock resolves the name, then looks at the address on
// both chains before it lets you pay it.
import { createPublicClient, getAddress, http, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { accountFacts, describe, short, type AccountFacts } from "./account.js";
import { ETHEREUM_RPC, type Chain } from "./chain.js";
import { PHAROS_CHAIN_ID } from "./registry.js";

/** ENSIP-11: an EVM chain's coin type is 0x80000000 | chainId. A name can carry a Pharos-only address there. */
export const PHAROS_COIN_TYPE = BigInt((0x80000000 | PHAROS_CHAIN_ID) >>> 0);

export interface Verdict {
  level: "PASS" | "WARN" | "BLOCK";
  says: string;
}

export interface NameCheck {
  name: string;
  address?: Hex;
  via: "ensip11" | "eth" | "none";
  l1?: AccountFacts;
  pharos?: AccountFacts;
  verdict: Verdict;
}

export type Resolver = (name: string, coinType?: bigint) => Promise<Hex | null>;

export function ensResolver(url = ETHEREUM_RPC): Resolver {
  const client = createPublicClient({ chain: mainnet, transport: http(url, { timeout: 10_000, retryCount: 1 }) });
  return async (name, coinType) => {
    const a = await client.getEnsAddress({ name: normalize(name), ...(coinType === undefined ? {} : { coinType }) });
    return a ? (a.toLowerCase() as Hex) : null;
  };
}

function judge(name: string, via: NameCheck["via"], l1: AccountFacts, ph: AccountFacts): Verdict {
  const at = short(l1.address);
  const onPharos = ph.code !== "0x" || ph.nonce > 0;
  if (via === "ensip11") {
    return onPharos
      ? { level: "PASS", says: `${name} has an address set for Pharos itself (${at}), and it is in use there: ${describe(ph)}.` }
      : { level: "WARN", says: `${name} has an address set for Pharos (${at}), but nothing has ever happened at it on Pharos. Make sure it is current.` };
  }
  if (l1.kind === "contract" && ph.code === "0x") {
    const what = describe(l1);
    return {
      level: "BLOCK",
      says:
        `${name} points to ${at}, which on Ethereum is ${what}. On Pharos there is nothing deployed at that address, ` +
        `so ${l1.safe ? "the Safe's owners" : "whoever controls that contract"} may have no way to move money sent there. ` +
        `Ask them for an address they use on Pharos.`,
    };
  }
  if (l1.kind === "contract") {
    const same = l1.code.toLowerCase() === ph.code.toLowerCase();
    return {
      level: "WARN",
      says: `${name} points to ${at}, ${describe(l1)} on Ethereum. On Pharos there is ${same ? "the same code" : "a different contract"} at that address: ${describe(ph)}. Check it is theirs on Pharos too.`,
    };
  }
  if (l1.kind === "delegated") {
    return {
      level: "WARN",
      says:
        `${name} points to ${at}, which on Ethereum is ${describe(l1)}. On Pharos it is ${describe(ph)}. ` +
        `The key behind it works on any chain, but its smart-wallet setup does not come along. Confirm with them before paying.`,
    };
  }
  return {
    level: "WARN",
    says: `${name} resolved on Ethereum to ${at} (${describe(l1)} there). ENS has no Pharos record for it; on Pharos it is ${describe(ph)}. A normal wallet uses the same key on both chains, but make sure this is the right person.`,
  };
}

export async function resolveName(name: string, ethereum: Chain, pharos: Chain, resolver: Resolver = ensResolver()): Promise<NameCheck> {
  let address: Hex | null = null;
  let via: NameCheck["via"] = "none";
  try {
    address = await resolver(name, PHAROS_COIN_TYPE);
    if (address) via = "ensip11";
    else {
      address = await resolver(name);
      if (address) via = "eth";
    }
  } catch (e) {
    return { name, via: "none", verdict: { level: "BLOCK", says: `could not resolve ${name} on Ethereum (${(e as Error).message.split("\n")[0]}). Not paying a name I could not check.` } };
  }
  if (!address) return { name, via, verdict: { level: "BLOCK", says: `${name} has no address in ENS. Ask for a full 0x address.` } };
  const [l1, ph] = await Promise.all([accountFacts(ethereum, address), accountFacts(pharos, address)]);
  return { name, address: getAddress(address), via, l1, pharos: ph, verdict: judge(name, via, l1, ph) };
}
