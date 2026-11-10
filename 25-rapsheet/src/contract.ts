// The record of a contract: how old it is, whether anyone can read its code, whether someone can swap that code, and
// whether they already did. Each of those is checked on the chain; the explorer only tells us where to look.
import { PROXY_LAYOUTS, slotAddress, type Chain } from "./chain.js";
import type { Explorer, Hex, Profile } from "./explorer.js";
import { addressLink, ago, blockLink, days, plural, short, txLink, type Finding } from "./finding.js";
import { powersIn } from "./powers.js";

export interface Look {
  target: Hex;
  chain: Chain;
  explorer: Explorer;
  head: number;
  now: number;
  profile: Profile;
  code: Hex;
}

export const CONTRACT_LIMITS = {
  /** Younger than this is HIGH: there's no track record at all. */
  youngHighDays: 3,
  /** Younger than this is MEDIUM. */
  youngMediumDays: 14,
  /** Code swapped within this many days, behind unverified code, is HIGH. */
  recentUpgradeDays: 7,
};

interface Birth {
  block: number;
  time: number;
  hash: Hex;
  checked: boolean;
}

// The explorer names the creation tx; the chain says which block it's in, and that the address had no code just
// before it and has code from it on. That's the age we report, not the explorer's timestamp.
async function birth(l: Look): Promise<Birth | null> {
  if (!l.profile.creationTx) return null;
  const mined = await l.chain.txBlock(l.profile.creationTx);
  if (!mined) return null;
  const [before, after, time] = await Promise.all([l.chain.code(l.target, mined.block - 1), l.chain.code(l.target, mined.block), l.chain.blockTime(mined.block)]);
  return { block: mined.block, time, hash: l.profile.creationTx, checked: before === "0x" && after !== "0x" };
}

function ageFinding(l: Look, b: Birth | null): Finding {
  if (!b) {
    return {
      id: "contract_age",
      title: "How old the contract is",
      level: "unchecked",
      said: "The explorer doesn't say which transaction created this contract, so we couldn't date it.",
      why: "A contract's age is the first thing to know: new code has no track record.",
      source: "explorer",
      evidence: [addressLink(l.target)],
    };
  }
  const age = l.now - b.time;
  const level = days(age) < CONTRACT_LIMITS.youngHighDays ? "high" : days(age) < CONTRACT_LIMITS.youngMediumDays ? "medium" : "ok";
  return {
    id: "contract_age",
    title: "How old the contract is",
    level,
    said: `It was created ${ago(age)} ago, in block ${b.block}${b.checked ? " (the chain has no code at this address one block earlier)" : ""}.`,
    why:
      level === "ok"
        ? ""
        : "New contracts have no history yet: nobody has had time to use them, audit them or get burned by them. Most rug pulls and drainers are days old.",
    source: b.checked ? "chain+explorer" : "explorer",
    evidence: [txLink(b.hash, `creation tx ${short(b.hash)}`), blockLink(b.block)],
  };
}

// Smallest block in (lo, hi] whose implementation slot already holds `impl`. The slot can only be changed by an
// upgrade, so this is the block of the upgrade that put today's code in place.
async function since(chain: Chain, a: Hex, slot: Hex, impl: Hex, lo: number, hi: number): Promise<number> {
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (slotAddress(await chain.storage(a, slot, mid)) === impl) hi = mid;
    else lo = mid;
  }
  return hi;
}

export async function contractRecord(l: Look): Promise<Finding[]> {
  const out: Finding[] = [];
  const b = await birth(l);
  out.push(ageFinding(l, b));

  // A proxy is an empty shell that runs someone else's code. What matters is that code, and who may replace it.
  let layout: (typeof PROXY_LAYOUTS)[number] = PROXY_LAYOUTS[0];
  let impl: Hex | null = null;
  for (const p of PROXY_LAYOUTS) {
    impl = slotAddress(await l.chain.storage(l.target, p.impl));
    if (impl) {
      layout = p;
      break;
    }
  }
  const implProfile = impl ? await l.explorer.profile(impl) : null;
  const subject = impl ?? l.target;
  const subjectProfile = implProfile ?? l.profile;
  const behind = impl ? `the code behind this proxy (${short(impl)})` : "its code";

  if (subjectProfile.verified === true) {
    out.push({
      id: "verified_source",
      title: "Can anyone read the code",
      level: "ok",
      said: `The source of ${behind} is published and verified on pharosscan.`,
      why: "",
      source: "explorer",
      evidence: [addressLink(subject, `${short(subject)} code`)],
    });
  } else if (subjectProfile.verified === false) {
    const twin = subjectProfile.verifiedTwins > 0;
    out.push({
      id: "verified_source",
      title: "Can anyone read the code",
      level: twin ? "info" : "medium",
      said: `The source of ${behind} is not verified: all anyone can see is bytecode.`,
      why: "Unverified code is a black box. You'd be trusting it without anyone being able to check what it does with your tokens.",
      source: "explorer",
      evidence: [addressLink(subject, `${short(subject)} code`)],
      easing: twin ? `Its bytecode is identical to ${plural(subjectProfile.verifiedTwins, "verified contract")}, so the source is known after all.` : undefined,
    });
  } else {
    out.push({
      id: "verified_source",
      title: "Can anyone read the code",
      level: "unchecked",
      said: "The explorer gave no verification status for this code.",
      why: "",
      source: "explorer",
      evidence: [addressLink(subject)],
    });
  }

  if (!impl) {
    const claimed = l.profile.explorerImpl;
    out.push({
      id: "upgradeable",
      title: "Can its code be swapped",
      level: claimed ? "info" : "ok",
      said: claimed
        ? `The standard proxy slot is empty, but the explorer says it forwards to ${short(claimed)}. We couldn't confirm that on the chain.`
        : "No: both standard proxy slots (EIP-1967 and the older ZeppelinOS one) are empty, so the code you see is the code that runs.",
      why: claimed ? "If it is a proxy of another kind, whoever controls it could change what it does." : "",
      source: claimed ? "chain+explorer" : "chain",
      evidence: [addressLink(l.target)],
    });
  } else {
    const admin = slotAddress(await l.chain.storage(l.target, layout.admin));
    const controller = admin ?? (await l.chain.owner(l.target));
    const how = admin ? "proxy admin" : "owner()";
    if (!controller) {
      out.push({
        id: "upgradeable",
        title: "Can its code be swapped",
        level: "info",
        said: `Yes: it is a proxy running ${short(impl)}. We couldn't tell who may upgrade it (no admin slot, no owner()).`,
        why: "Whoever holds the upgrade right can replace the code with anything, including code that takes approved tokens.",
        source: "chain",
        evidence: [addressLink(impl, `implementation ${short(impl)}`)],
      });
    } else {
      const isKey = (await l.chain.code(controller)) === "0x";
      out.push({
        id: "upgradeable",
        title: "Can its code be swapped",
        level: isKey ? "medium" : "info",
        said: isKey
          ? `Yes, by one private key: it is a proxy running ${short(impl)}, and its ${how} is a plain wallet, ${short(controller)}.`
          : `Yes: it is a proxy running ${short(impl)}, and its ${how} is a contract, ${short(controller)} (maybe a multisig or a timelock; we didn't check which).`,
        why: isKey
          ? "Whoever holds that one key can swap the code at any moment, without asking anyone, including for code that drains what you approved."
          : "Upgrades go through another contract. That can be a safeguard, or not; it depends on what that contract is.",
        source: "chain",
        evidence: [addressLink(controller, `${how} ${short(controller)}`), addressLink(impl, `implementation ${short(impl)}`)],
      });
    }

    const lo = b?.block ?? 0;
    const same = lo > 0 && slotAddress(await l.chain.storage(l.target, layout.impl, lo)) === impl;
    if (same) {
      out.push({
        id: "code_changed",
        title: "Has its code been swapped",
        level: "ok",
        said: `No: the same implementation has been in place since the contract was created (block ${lo}).`,
        why: "",
        source: "chain",
        evidence: [blockLink(lo)],
      });
    } else {
      const at = await since(l.chain, l.target, layout.impl, impl, lo, l.head);
      const [when, logs] = await Promise.all([l.chain.blockTime(at), l.chain.upgrades(l.target, at, at)]);
      const recent = days(l.now - when) < CONTRACT_LIMITS.recentUpgradeDays;
      const stale = l.profile.explorerImpl && l.profile.explorerImpl !== impl ? ` (pharosscan still shows the older ${short(l.profile.explorerImpl)}; the chain says ${short(impl)})` : "";
      const level = recent && subjectProfile.verified !== true ? "high" : "medium";
      out.push({
        id: "code_changed",
        title: "Has its code been swapped",
        level,
        said:
          `Yes: the code running today was put in ${ago(l.now - when)} ago, in block ${at}` +
          (b ? `, ${ago(when - b.time)} after the contract went live` : "") +
          `${stale}.`,
        why:
          level === "high"
            ? "The contract you'd be trusting changed this week, and nobody can read the new code. Whatever people trusted it for before doesn't carry over."
            : "What the contract does today is not what it did at launch, so its history says less about it than you'd think.",
        source: "chain",
        evidence: [...logs.map((x) => txLink(x.hash, `upgrade tx ${short(x.hash)}`)), blockLink(at)],
      });
    }
  }

  const runs = impl ? await l.chain.code(impl) : l.code;
  const found = powersIn(runs);
  out.push({
    id: "powers",
    title: "What its owner can do",
    level: found.length === 0 ? "ok" : "info",
    said:
      found.length === 0
        ? "Its bytecode has none of the usual owner switches (mint, pause, blacklist, fees, limits, upgrade, withdraw)."
        : `Its bytecode has functions to ${found.map((f) => f.power).join("; ")}.`,
    why:
      found.length === 0
        ? ""
        : "These are normal in many tokens, but each one is a lever someone holds over your money. With unverified code you can't see who may pull it.",
    source: "chain",
    evidence: [addressLink(subject, `${short(subject)} code`)],
  });

  return out;
}
