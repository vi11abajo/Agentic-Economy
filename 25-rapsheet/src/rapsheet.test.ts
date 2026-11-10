import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { card, markdown } from "./card.js";
import { ADMIN_SLOT, IMPL_SLOT, OLD_IMPL_SLOT } from "./chain.js";
import type { Hex } from "./explorer.js";
import { A, fakeChain, fakeExplorer, H, list, profile, tx, word } from "./fake.js";
import type { Finding } from "./finding.js";
import { glance } from "./mine.js";
import { powersIn, push4s } from "./powers.js";
import { rapsheet } from "./rapsheet.js";
import { exitCode, verdict } from "./verdict.js";
import { APPROVE } from "./wallet.js";

const HEAD = 1_000_000;
const SPB = 10; // seconds per block: the fake chain spans about 116 days
const GENESIS = 1_700_000_000;
const NOW = GENESIS + HEAD * SPB;
const blockAgo = (days: number) => HEAD - Math.round((days * 86_400) / SPB);
const timeAgo = (days: number) => NOW - Math.round(days * 86_400);
const CODE = "0x6080604052" as Hex;

const f = (level: Finding["level"]): Finding => ({ id: "x", title: "x", level, said: "", why: "", source: "chain", evidence: [] });
const pick = (fs: Finding[], id: string) => fs.filter((x) => x.id === id);

test("one HIGH or three MEDIUM make it HIGH, one or two MEDIUM make it MEDIUM", () => {
  assert.equal(verdict([f("ok"), f("info")]).risk, "LOW");
  assert.equal(verdict([f("medium")]).risk, "MEDIUM");
  assert.equal(verdict([f("medium"), f("medium")]).risk, "MEDIUM");
  assert.equal(verdict([f("medium"), f("medium"), f("medium")]).risk, "HIGH");
  assert.equal(verdict([f("high"), f("ok")]).risk, "HIGH");
  assert.equal(verdict([f("unchecked")]).unchecked.length, 1);
  assert.deepEqual([exitCode("LOW"), exitCode("MEDIUM"), exitCode("HIGH")], [0, 1, 2]);
});

test("selectors are read from PUSH4 only, never from inside another push's data", () => {
  const pause = toFunctionSelector("function pause()").slice(2);
  // PUSH32 whose data happens to contain 63 + pause's selector, then a real PUSH4 of mint
  const mint = toFunctionSelector("function mint(address,uint256)").slice(2);
  const hidden = `7f63${pause}${"00".repeat(27)}`;
  const code = `0x${hidden}63${mint}` as Hex;
  assert.deepEqual([...push4s(code)], [`0x${mint}`]);
  assert.deepEqual(
    powersIn(code).map((p) => p.power),
    ["create new tokens out of nothing (mint)"],
  );
});

function contractWorld() {
  const chain = fakeChain(HEAD, SPB, GENESIS);
  const explorer = fakeExplorer();
  return { chain, explorer };
}

test("an old verified contract with no proxy is LOW", async () => {
  const { chain, explorer } = contractWorld();
  const c = A(0xc0de);
  const born = blockAgo(100);
  chain.codes.set(c, CODE);
  chain.born.set(c, born);
  chain.mined.set(H(1), { block: born, from: A(1) });
  explorer.profiles.set(c, profile(c, { isContract: true, name: "Good", verified: true, creationTx: H(1) }));
  const r = await rapsheet(c, chain, explorer, { now: NOW });
  assert.equal(r.kind, "contract");
  assert.equal(r.verdict.risk, "LOW");
  assert.match(pick(r.findings, "contract_age")[0].said, /no code at this address one block earlier/);
});

test("a proxy whose code was swapped this week behind unverified code is HIGH, and the upgrade block is found exactly", async () => {
  const { chain, explorer } = contractWorld();
  const p = A(0xa11), oldImpl = A(0x1), newImpl = A(0x2), staleImpl = A(0x3);
  const born = blockAgo(60);
  const swapped = blockAgo(1) + 17;
  chain.codes.set(p, CODE);
  chain.born.set(p, born);
  chain.mined.set(H(9), { block: born, from: A(5) });
  chain.slots.set(`${p}:${IMPL_SLOT}`, [
    [born, word(oldImpl)],
    [swapped, word(newImpl)],
  ]);
  chain.codes.set(newImpl, CODE);
  chain.upgradeLogs.set(p, [{ block: swapped, hash: H(77), impl: newImpl }]);
  explorer.profiles.set(p, profile(p, { isContract: true, verified: false, proxy: true, explorerImpl: staleImpl, creationTx: H(9) }));
  explorer.profiles.set(newImpl, profile(newImpl, { isContract: true, verified: false }));

  const r = await rapsheet(p, chain, explorer, { now: NOW });
  const changed = pick(r.findings, "code_changed")[0];
  assert.equal(changed.level, "high");
  assert.match(changed.said, new RegExp(`block ${swapped}`));
  assert.match(changed.said, /pharosscan still shows the older/);
  assert.ok(changed.evidence.some((e) => e.url.endsWith(H(77))));
  assert.equal(pick(r.findings, "verified_source")[0].level, "medium");
  assert.equal(r.verdict.risk, "HIGH");
  assert.ok(chain.storageReads < 40, `binary search should be cheap, used ${chain.storageReads} reads`);
});

test("a proxy whose admin is one private key is flagged; the old ZeppelinOS slot is understood", async () => {
  const { chain, explorer } = contractWorld();
  const p = A(0xbb), impl = A(0xbc), key = A(0xbd);
  const born = blockAgo(200 / 10);
  chain.codes.set(p, CODE);
  chain.born.set(p, born);
  chain.codes.set(impl, CODE);
  chain.mined.set(H(3), { block: born, from: A(5) });
  chain.slots.set(`${p}:${OLD_IMPL_SLOT}`, [[born, word(impl)]]);
  chain.slots.set(`${p}:0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b`, [[born, word(key)]]);
  explorer.profiles.set(p, profile(p, { isContract: true, creationTx: H(3) }));
  explorer.profiles.set(impl, profile(impl, { isContract: true, verified: true }));
  const r = await rapsheet(p, chain, explorer, { now: NOW });
  const up = pick(r.findings, "upgradeable")[0];
  assert.equal(up.level, "medium");
  assert.match(up.said, /one private key/);
  assert.equal(pick(r.findings, "code_changed")[0].level, "ok");
  assert.equal(r.verdict.risk, "MEDIUM");
  // the EIP-1967 admin slot isn't consulted for a ZeppelinOS proxy
  assert.equal(chain.slots.has(`${p}:${ADMIN_SLOT}`), false);
});

test("unverified code that is a byte-for-byte twin of verified code is only a note", async () => {
  const { chain, explorer } = contractWorld();
  const c = A(0xdd);
  chain.codes.set(c, CODE);
  explorer.profiles.set(c, profile(c, { isContract: true, verified: false, verifiedTwins: 4 }));
  const r = await rapsheet(c, chain, explorer, { now: NOW });
  const v = pick(r.findings, "verified_source")[0];
  assert.equal(v.level, "info");
  assert.match(v.easing!, /identical to 4 verified contracts/);
  assert.equal(pick(r.findings, "contract_age")[0].level, "unchecked");
});

function walletWorld() {
  const chain = fakeChain(HEAD, SPB, GENESIS);
  const explorer = fakeExplorer();
  const w = A(0xfeed);
  return { chain, explorer, w };
}

const approveInput = (spender: Hex, amount: bigint) => encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [spender, amount] });

test("an open approval to a plain wallet is HIGH; a revoked one is not", async () => {
  const { chain, explorer, w } = walletWorld();
  const token = A(0x70c), thief = A(0xbad), gone = A(0xbae);
  explorer.profiles.set(w, profile(w, { firstTx: { hash: H(1), block: blockAgo(90), time: timeAgo(90) } }));
  explorer.txLists.set(
    w,
    list([
      tx({ hash: H(20), from: w, to: token, methodId: APPROVE, time: timeAgo(3) }),
      tx({ hash: H(21), from: w, to: token, methodId: APPROVE, time: timeAgo(4) }),
    ]),
  );
  chain.inputs.set(H(20), approveInput(thief, 2n ** 256n - 1n));
  chain.inputs.set(H(21), approveInput(gone, 2n ** 256n - 1n));
  chain.allowances.set(`${token}:${w}:${thief}`, 2n ** 256n - 1n);
  chain.allowances.set(`${token}:${w}:${gone}`, 0n);
  const r = await rapsheet(w, chain, explorer, { now: NOW });
  const open = pick(r.findings, "open_approvals");
  assert.equal(open.length, 1);
  assert.equal(open[0].level, "high");
  assert.match(open[0].said, /plain wallet/);
  assert.equal(r.verdict.risk, "HIGH");
});

test("an unlimited approval to a contract the wallet deployed itself is eased, not flagged", async () => {
  const { chain, explorer, w } = walletWorld();
  const token = A(0x70c), bot = A(0xb07);
  explorer.profiles.set(w, profile(w, { firstTx: { hash: H(1), block: blockAgo(90), time: timeAgo(90) } }));
  explorer.profiles.set(bot, profile(bot, { isContract: true, verified: false, creator: w, createdAt: timeAgo(1) }));
  explorer.txLists.set(w, list([tx({ hash: H(30), from: w, to: token, methodId: APPROVE, time: timeAgo(1) })]));
  chain.codes.set(bot, CODE);
  chain.inputs.set(H(30), approveInput(bot, 2n ** 256n - 1n));
  chain.allowances.set(`${token}:${w}:${bot}`, 2n ** 256n - 1n);
  const r = await rapsheet(w, chain, explorer, { now: NOW });
  const open = pick(r.findings, "open_approvals")[0];
  assert.equal(open.level, "info");
  assert.match(open.easing!, /deployed that contract itself/);
});

test("a fresh wallet seeded by a funder that sprayed a crowd of new wallets adds up to HIGH", async () => {
  const { chain, explorer, w } = walletWorld();
  const funder = A(0xf00);
  const fundedAt = timeAgo(0.2);
  explorer.profiles.set(w, profile(w, { funding: { from: funder, value: "0.5", hash: H(40), time: fundedAt } }));
  explorer.profiles.set(funder, profile(funder, { firstTx: { hash: H(41), block: blockAgo(3), time: timeAgo(3) } }));
  const sprays = Array.from({ length: 12 }, (_, i) => tx({ hash: H(100 + i), from: funder, to: A(0x9000 + i), value: "0.5", time: fundedAt + i * 60 }));
  explorer.txLists.set(funder, list(sprays));
  chain.nonces.set(w, 0);
  const r = await rapsheet(w, chain, explorer, { now: NOW });
  assert.equal(pick(r.findings, "wallet_age")[0].level, "medium");
  assert.equal(pick(r.findings, "fresh_funding")[0].level, "medium");
  const spray = pick(r.findings, "funder")[0];
  assert.equal(spray.level, "medium");
  assert.match(spray.said, /12 wallets, 12 of them the exact same amount/);
  assert.equal(r.verdict.risk, "HIGH");
});

test("seen from your history: a look-alike of someone you paid, plus dust it sent you, is address poisoning", async () => {
  const { chain, explorer } = walletWorld();
  const me = A(0x1234);
  const real = "0xabcd000000000000000000000000000000001111" as Hex;
  const fake = "0xabcd999999999999999999999999999999991111" as Hex;
  assert.equal(glance(real), glance(fake));
  explorer.profiles.set(fake, profile(fake, { firstTx: { hash: H(50), block: blockAgo(30), time: timeAgo(30) } }));
  explorer.txLists.set(me, list([tx({ hash: H(51), from: me, to: real, value: "5", time: timeAgo(10) })]));
  explorer.transferLists.set(me, list([{ hash: H(52), token: A(0x70c), symbol: "USDC", from: fake, to: me, value: "0", block: 1, time: timeAgo(2) }]));
  const r = await rapsheet(fake, chain, explorer, { me, now: NOW });
  const look = pick(r.findings, "look_alike")[0];
  assert.equal(look.level, "high");
  assert.equal(pick(r.findings, "dust_to_me")[0].level, "high");
  assert.match(pick(r.findings, "first_contact")[0].said, /^Yes: it appears once/);
  assert.equal(r.verdict.risk, "HIGH");
});

test("a plain wallet holding someone else's open approval is HIGH; a closed one only counts as seen", async () => {
  const { chain, explorer, w } = walletWorld();
  const token = A(0x70c), victim = A(0x51c), careful = A(0x5af);
  explorer.profiles.set(w, profile(w, { firstTx: { hash: H(1), block: blockAgo(90), time: timeAgo(90) } }));
  chain.approvalLogs.set(w, [
    { token, owner: victim, value: 114072n, block: HEAD - 5000, hash: H(70) },
    { token, owner: careful, value: 5n, block: HEAD - 4000, hash: H(71) },
  ]);
  chain.allowances.set(`${token}:${victim}:${w}`, 114072n);
  const r = await rapsheet(w, chain, explorer, { now: NOW, window: 20_000 });
  const got = pick(r.findings, "approvals_received")[0];
  assert.equal(got.level, "high");
  assert.match(got.said, /^1 other wallet gave this plain wallet the right to move their tokens/);
  assert.match(got.said, /the last 20000 blocks/);
  assert.equal(r.verdict.risk, "HIGH");
});

test("a counterparty on your watchlist is HIGH and names your reason and source", async () => {
  const { chain, explorer, w } = walletWorld();
  const bad = A(0xdead);
  explorer.profiles.set(w, profile(w, { firstTx: { hash: H(1), block: blockAgo(90), time: timeAgo(90) } }));
  explorer.txLists.set(w, list([tx({ hash: H(60), from: bad, to: w, value: "1", time: timeAgo(5) })]));
  const r = await rapsheet(w, chain, explorer, { now: NOW, watchlist: [{ address: bad, reason: "drained my friend", source: "my notes" }] });
  const hit = pick(r.findings, "watchlist")[0];
  assert.equal(hit.level, "high");
  assert.match(hit.said, /drained my friend; source: my notes/);
});

test("the card and the markdown carry the level, the rule and every evidence link", async () => {
  const { chain, explorer, w } = walletWorld();
  explorer.profiles.set(w, profile(w, { firstTx: { hash: H(1), block: blockAgo(90), time: timeAgo(90) } }));
  explorer.txLists.set(w, list([], true));
  const r = await rapsheet(w, chain, explorer, { now: NOW });
  const text = card(r);
  assert.match(text, /RISK: LOW - no red flags/);
  assert.match(text, /Not checked: who paid for its first gas; older history; approvals given to it earlier\./);
  assert.match(text, /not proof of a crime/);
  const md = markdown(r);
  for (const x of r.findings) for (const e of x.evidence) assert.ok(md.includes(e.url));
});
