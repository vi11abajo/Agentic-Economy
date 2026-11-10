// A pretend chain and explorer for the tests: just enough state to play out each record without the network.
import type { ApprovalLog, Chain, UpgradeLog } from "./chain.js";
import type { Explorer, Hex, Listing, Profile, Transfer, Tx } from "./explorer.js";

export const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
export const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
export const word = (a: Hex | null) => (a ? (`0x${a.slice(2).padStart(64, "0")}` as Hex) : H(0));

export function profile(address: Hex, p: Partial<Profile> = {}): Profile {
  return {
    address,
    isContract: false,
    name: null,
    verified: null,
    proxy: null,
    explorerImpl: null,
    verifiedTwins: 0,
    creator: null,
    creationTx: null,
    createdAt: null,
    firstTx: null,
    funding: null,
    tags: [],
    ...p,
  };
}

export interface FakeChain extends Chain {
  codes: Map<Hex, Hex>;
  /** address -> block from which the code exists */
  born: Map<Hex, number>;
  /** address:slot -> list of [fromBlock, value], ascending */
  slots: Map<string, [number, Hex][]>;
  owners: Map<Hex, Hex>;
  allowances: Map<string, bigint>;
  nonces: Map<Hex, number>;
  inputs: Map<Hex, Hex>;
  mined: Map<Hex, { block: number; from: Hex }>;
  upgradeLogs: Map<Hex, UpgradeLog[]>;
  /** spender -> approvals naming it */
  approvalLogs: Map<Hex, ApprovalLog[]>;
  storageReads: number;
}

export function fakeChain(head = 1_000_000, secondsPerBlock = 1, genesis = 1_700_000_000): FakeChain {
  const c: FakeChain = {
    codes: new Map(),
    born: new Map(),
    slots: new Map(),
    owners: new Map(),
    allowances: new Map(),
    nonces: new Map(),
    inputs: new Map(),
    mined: new Map(),
    upgradeLogs: new Map(),
    approvalLogs: new Map(),
    storageReads: 0,
    head: async () => head,
    blockTime: async (n) => genesis + n * secondsPerBlock,
    async code(a, block) {
      const b = c.born.get(a) ?? 0;
      if (block !== undefined && block < b) return "0x";
      return c.codes.get(a) ?? "0x";
    },
    async storage(a, slot, block) {
      c.storageReads++;
      const hist = c.slots.get(`${a}:${slot}`) ?? [];
      let v: Hex = H(0);
      for (const [from, val] of hist) if (block === undefined || from <= block) v = val;
      return v;
    },
    nonce: async (a) => c.nonces.get(a) ?? 0,
    owner: async (a) => c.owners.get(a) ?? null,
    allowance: async (t, o, s) => c.allowances.get(`${t}:${o}:${s}`) ?? 0n,
    upgrades: async (a, from, to) => (c.upgradeLogs.get(a) ?? []).filter((l) => l.block >= from && l.block <= to),
    async approvalsTo(s, from, to) {
      if (to - from > 999) throw new Error("the node refuses spans over 1,000 blocks");
      return (c.approvalLogs.get(s) ?? []).filter((l) => l.block >= from && l.block <= to);
    },
    txBlock: async (h) => c.mined.get(h) ?? null,
    txInput: async (h) => c.inputs.get(h) ?? null,
  };
  return c;
}

export interface FakeExplorer extends Explorer {
  profiles: Map<Hex, Profile>;
  txLists: Map<Hex, Listing<Tx>>;
  transferLists: Map<Hex, Listing<Transfer>>;
}

export function fakeExplorer(): FakeExplorer {
  const e: FakeExplorer = {
    profiles: new Map(),
    txLists: new Map(),
    transferLists: new Map(),
    profile: async (a) => e.profiles.get(a) ?? profile(a),
    txs: async (a) => e.txLists.get(a) ?? { rows: [], total: 0, cut: false },
    transfers: async (a) => e.transferLists.get(a) ?? { rows: [], total: 0, cut: false },
  };
  return e;
}

export const list = <T>(rows: T[], cut = false): Listing<T> => ({ rows, total: rows.length, cut });

export function tx(p: Partial<Tx> & { hash: Hex; from: Hex }): Tx {
  return { to: null, value: "0", methodId: "0x", block: 1, time: 0, ok: true, ...p };
}
