import test from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Address, type Hex } from "viem";
import { telegramText } from "../src/alert.js";
import { channels, redact, type Net } from "../src/deliver.js";
import { flush } from "../src/outbox.js";
import { TOKENS } from "../src/pharos.js";
import { RuleError, loadRules } from "../src/rules.js";
import { empty, enqueue } from "../src/state.js";
import { round, type Ctx } from "../src/watch.js";

// A pretend Pharos: the logs, feed answers and transactions are whatever the test puts in.
const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const DEX = "0xa5ca5fbe34e444f366b373170541ec6902b0f75c" as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

interface World {
  head: bigint;
  logs: Array<{ token: Address; from: Address; to: Address; value: bigint; block: bigint; tx: Hex; i: number }>;
  price: bigint; // 18 decimals
  updatedAt: bigint;
  txs: Record<string, { to: Address; from: Address; input: Hex; value: bigint; blockNumber: bigint }>;
  explorer: Array<Record<string, unknown>>;
  getLogsCalls: number;
}

function world(): World {
  return { head: 1000n, logs: [], price: parseEther("0.47"), updatedAt: 1_800_000_000n, txs: {}, explorer: [], getLogsCalls: 0 };
}

function client(w: World) {
  return {
    getBlockNumber: async () => w.head,
    getLogs: async ({ address, fromBlock, toBlock }: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
      w.getLogsCalls++;
      assert.ok(toBlock - fromBlock < 1000n, "no getLogs range over 1000 blocks");
      return w.logs
        .filter((l) => l.token.toLowerCase() === address.toLowerCase() && l.block >= fromBlock && l.block <= toBlock)
        .map((l) => ({ args: { from: l.from, to: l.to, value: l.value }, transactionHash: l.tx, logIndex: l.i, blockNumber: l.block, blockTimestamp: 1_800_000_000n }));
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "decimals") return 18;
      if (functionName === "symbol") return "FOO";
      if (functionName === "latestRoundData") return [1n, w.price, 0n, w.updatedAt, 1n];
      throw new Error(functionName);
    },
    getTransaction: async ({ hash: h }: { hash: Hex }) => w.txs[h],
  } as never;
}

function explorerNet(w: World): Net {
  return (async (url: string | URL | Request) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    return new Response(JSON.stringify({ data: page === 1 ? w.explorer : [] }));
  }) as Net;
}

async function ctxFor(w: World, rules: object): Promise<Ctx> {
  const cfg = await loadRules(JSON.stringify(rules), client(w));
  return { client: client(w), net: explorerNet(w), cfg, state: empty(), say: () => {} };
}

test("rules: a bad file stops siren at start with a reason", async () => {
  const c = client(world());
  await assert.rejects(loadRules("{", c), RuleError);
  await assert.rejects(loadRules(`{"rules":[{"kind":"swap"}]}`, c), /transfer, price or call/);
  await assert.rejects(loadRules(`{"rules":[{"kind":"price","above":1,"below":0.5}]}`, c), /exactly one/);
  await assert.rejects(loadRules(`{"rules":[{"kind":"transfer","token":"0x12","min":1}]}`, c), /not an address/);
  await assert.rejects(loadRules(`{"rules":[{"name":"a","kind":"transfer","token":"USDC","min":1},{"name":"a","kind":"transfer","token":"USDC","min":2}]}`, c), /two rules/);
  await assert.rejects(loadRules(`{"rules":[{"kind":"call","to":"${DEX}","selector":"0x12"}]}`, c), /4 bytes/);
});

test("rules: known tokens by name, others read from chain, functions turn into selectors", async () => {
  const cfg = await loadRules(
    JSON.stringify({
      rules: [
        { name: "u", kind: "transfer", token: "usdc", min: 5 },
        { name: "x", kind: "transfer", token: "0x3333333333333333333333333333333333333333", min: 5 },
        { name: "c", kind: "call", to: DEX, function: "transfer(address to, uint256 amount)" },
      ],
    }),
    client(world()),
  );
  assert.equal(cfg.rules[0].kind === "transfer" && cfg.rules[0].token.address, TOKENS.USDC.address);
  assert.equal(cfg.rules[1].kind === "transfer" && cfg.rules[1].token.symbol, "FOO");
  assert.equal(cfg.rules[2].kind === "call" && cfg.rules[2].selector, "0xa9059cbb");
});

test("first start without --since begins at the head and alerts nothing old", async () => {
  const w = world();
  w.logs.push({ token: TOKENS.USDC.address, from: ALICE, to: BOB, value: 900_000_000n, block: 990n, tx: hash(1), i: 0 });
  const ctx = await ctxFor(w, { rules: [{ name: "u", kind: "transfer", token: "USDC", min: 100 }] });
  const r = await round(ctx);
  assert.equal(r.queued, 0);
  assert.equal(ctx.state.lastBlock, "1000");
});

test("transfers: size, direction filter, mint wording, and no second alert for the same log", async () => {
  const w = world();
  const usdc = TOKENS.USDC.address;
  w.logs.push(
    { token: usdc, from: ALICE, to: BOB, value: 500_000_000n, block: 995n, tx: hash(1), i: 3 }, // 500 USDC
    { token: usdc, from: ALICE, to: BOB, value: 99_000_000n, block: 996n, tx: hash(2), i: 0 }, // too small
    { token: usdc, from: ZERO, to: BOB, value: 1_000_000_000n, block: 997n, tx: hash(3), i: 0 }, // mint
    { token: usdc, from: BOB, to: ALICE, value: 700_000_000n, block: 998n, tx: hash(4), i: 1 }, // to Alice only
  );
  const ctx = await ctxFor(w, { rules: [{ name: "to-alice", kind: "transfer", token: "USDC", min: 600, to: ALICE }, { name: "big", kind: "transfer", token: "USDC", min: 100 }] });
  const r = await round(ctx, 10n);
  assert.equal(r.queued, 3);
  const titles = ctx.state.outbox.map((p) => [p.alert.rule, p.alert.title, p.alert.value]);
  assert.deepEqual(titles, [
    ["big", "Large USDC transfer", "500 USDC"],
    ["big", "USDC minted", "1,000 USDC"],
    ["to-alice", "Large USDC transfer", "700 USDC"],
  ]);
  assert.ok(ctx.state.outbox[0].alert.links[0][1].endsWith(`/tx/${hash(1)}`));
  // siren restarts and somehow reads the same blocks again: nothing new is queued
  ctx.state.lastBlock = "990";
  assert.equal((await round(ctx)).queued, 0);
});

test("a long gap is read in chunks the RPC accepts", async () => {
  const w = world();
  w.head = 5000n;
  w.logs.push({ token: TOKENS.USDC.address, from: ALICE, to: BOB, value: 500_000_000n, block: 2500n, tx: hash(9), i: 0 });
  const ctx = await ctxFor(w, { rules: [{ name: "u", kind: "transfer", token: "USDC", min: 100 }] });
  ctx.state.lastBlock = "1";
  assert.equal((await round(ctx)).queued, 1);
  assert.equal(w.getLogsCalls, 5);
});

test("price: fires once on the crossing, stays quiet near the line, fires again after coming back", async () => {
  const w = world();
  const ctx = await ctxFor(w, { rules: [{ name: "low", kind: "price", feed: "PROS/USD", below: 0.45 }] });
  const at = async (p: string) => {
    w.price = parseEther(p);
    w.updatedAt++;
    return (await round(ctx)).queued;
  };
  assert.equal(await at("0.47"), 0);
  assert.equal(await at("0.44"), 1);
  assert.equal(await at("0.449"), 0);
  assert.equal(await at("0.451"), 0, "only 0.2% back, not re-armed yet");
  assert.equal(await at("0.448"), 0);
  assert.equal(await at("0.46"), 0, "back past the line by more than 0.5%: armed again");
  assert.equal(await at("0.43"), 1);
  const a = ctx.state.outbox.at(-1)!.alert;
  assert.equal(a.value, "$0.4300");
  assert.deepEqual(a.facts[1], ["before", "$0.4600"]);
});

test("calls: explorer rows are filtered, then each is checked against the RPC", async () => {
  const w = world();
  const row = (n: number, extra: object) => ({ hash: hash(n), to_address: DEX, method_id: "0xff84aafa", value: "120", block_number: 995, block_timestamp: "2026-11-14T17:43:49+00:00", receipt_status: 1, ...extra });
  w.explorer = [row(1, {}), row(2, { receipt_status: 0 }), row(3, { value: "10" }), row(4, { to_address: ALICE }), row(5, {}), row(6, { block_number: 10 })];
  w.txs[hash(1)] = { to: DEX, from: ALICE, input: "0xff84aafa00", value: parseEther("120"), blockNumber: 995n };
  // the explorer row says 120 PROS but the chain says 1: the chain wins
  w.txs[hash(5)] = { to: DEX, from: ALICE, input: "0xff84aafa00", value: parseEther("1"), blockNumber: 995n };
  const ctx = await ctxFor(w, { rules: [{ name: "dex", kind: "call", label: "DEX swap", to: DEX, minValue: 50 }] });
  const r = await round(ctx, 10n);
  assert.equal(r.queued, 1);
  assert.equal(ctx.state.outbox[0].alert.value, "120 PROS sent with the call");
  assert.equal((await round(ctx)).queued, 0);
});

test("outbox: a failed channel retries alone, the other doesn't get a copy twice, secrets never print", async () => {
  const token = "123456:SECRET-token-value";
  const hook = "https://discord.com/api/webhooks/1/hook-secret-part";
  let tg = 0;
  let dc = 0;
  let tgDown = true;
  const net = (async (url: string | URL | Request) => {
    if (String(url).startsWith("https://api.telegram.org")) {
      tg++;
      if (tgDown) throw new Error(`connect ECONNREFUSED ${String(url)}`);
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }
    dc++;
    return new Response(null, { status: 204 });
  }) as Net;
  const s = { telegramToken: token, telegramChatId: "42", discordWebhook: hook };
  const chans = channels(s, net);
  const state = empty();
  enqueue(state, { id: "x", rule: "r", kind: "transfer", title: "t <b>", value: "1 USDC", facts: [], links: [], at: "2026-11-14T00:00:00Z" });
  assert.equal(enqueue(state, { id: "x", rule: "r", kind: "transfer", title: "t", value: "1", facts: [], links: [], at: "" }), false);
  const lines: string[] = [];
  let f = await flush(state, chans, (l) => lines.push(l));
  assert.equal(f.waiting, 1);
  assert.ok(f.problems.every((p) => !p.includes(token) && !p.includes("SECRET")), f.problems.join("\n"));
  tgDown = false;
  f = await flush(state, chans, (l) => lines.push(l));
  assert.equal(f.sent, 1);
  assert.equal(state.outbox.length, 0);
  assert.equal(dc, 1, "Discord got it once");
  assert.equal(tg, 2);
  assert.equal(lines.length, 1, "printed to the console once");
  assert.equal(redact(`POST ${hook} failed`, s), "POST <hidden> failed");
});

test("telegram text escapes what could break the HTML", () => {
  const t = telegramText({ id: "1", rule: "r", kind: "call", title: "a<b>&c", value: "v", facts: [["k", "<x>"]], links: [["tx", "https://x/tx?a=1&b=2"]], at: "now" });
  assert.ok(t.includes("a&lt;b&gt;&amp;c"));
  assert.ok(t.includes("&lt;x&gt;"));
  assert.ok(t.includes('href="https://x/tx?a=1&amp;b=2"'));
});
