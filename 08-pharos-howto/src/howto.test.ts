// End-to-end tests of the CLI on recorded Docs MCP replies (test/fixtures) and a fake chain that mines what it
// is sent. The key is a throwaway one generated for the test.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  parseTransaction,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Chain, Receipt } from "./chain.js";
import { main } from "./cli.js";
import type { DocsSource } from "./docs.js";
import { normUrl, type Plan } from "./plan.js";

const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");
const USDC = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815" as Address;
const BOB = "0x37BD4152477F49B0E4E76caEB0Ca80d13c2Ee6F5" as Address;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function transfer(address,uint256) returns (bool)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);

function fakeDocs(answer: string): () => Promise<DocsSource> {
  return async () => ({ ask: async () => answer, search: async () => "", page: async () => "# Token Registry\n...", close: async () => {} });
}

/** Mines every transaction it is sent in block 101, charging gas used x 10 gwei (what mainnet does). */
function fakeChain(me: Address) {
  const sent: Hex[] = [];
  const receipts = new Map<Hex, Receipt>();
  const native = { 100: parseEther("1"), 101: parseEther("1") } as Record<number, bigint>;
  const usdc: Record<number, Record<string, bigint>> = { 100: { [me.toLowerCase()]: 5_000_000n }, 101: { [me.toLowerCase()]: 5_000_000n } };
  const chain: Chain = {
    gasPrice: async () => ({ gasPrice: 10_000_000_000n, priority: 0n }),
    balance: async (_a, b) => native[Number(b ?? 101n)],
    call: async (_to, data, b) => {
      const d = decodeFunctionData({ abi: erc20, data });
      if (d.functionName === "decimals") return encodeAbiParameters([{ type: "uint8" }], [6]);
      const who = String(d.args![0]).toLowerCase();
      return encodeAbiParameters([{ type: "uint256" }], [usdc[Number(b ?? 101n)][who] ?? 0n]);
    },
    estimateGas: async () => 50_000n,
    nonce: async () => 7,
    sendRaw: async (raw) => {
      sent.push(raw);
      const tx = parseTransaction(raw);
      const hash = keccak256(raw);
      const gasUsed = 40_000n;
      native[101] = native[100] - (tx.value ?? 0n) - gasUsed * 10_000_000_000n;
      const logs = [];
      if (tx.data && tx.data !== "0x") {
        const [to, amount] = decodeFunctionData({ abi: erc20, data: tx.data }).args as [Address, bigint];
        usdc[101][me.toLowerCase()] -= amount;
        usdc[101][to.toLowerCase()] = (usdc[101][to.toLowerCase()] ?? 0n) + amount;
        logs.push({ address: USDC, topics: encodeEventTopics({ abi: erc20, eventName: "Transfer", args: { from: me, to } }) as Hex[], data: pad(`0x${amount.toString(16)}`) });
      }
      receipts.set(hash, { hash, status: "success", block: 101n, from: me, to: tx.to!, gasUsed, effectiveGasPrice: 10_000_000_000n, logs });
      return hash;
    },
    receipt: async (h) => receipts.get(h) ?? null,
    transaction: async () => null,
    code: async () => "0x",
    logs: async () => [],
    blockNumber: async () => 101n,
    close: async () => {},
  };
  return { chain, sent };
}

function setup(answer = fixture("ask-gas.txt")) {
  const home = mkdtempSync(join(tmpdir(), "howto-"));
  mkdirSync(home, { recursive: true });
  const key = generatePrivateKey();
  writeFileSync(join(home, ".env"), `PRIVATE_KEY=${key}\n`);
  const me = privateKeyToAccount(key).address;
  const fc = fakeChain(me);
  const lines: string[] = [];
  const deps = { home, docs: fakeDocs(answer), chain: async () => fc.chain, out: (s: string) => lines.push(s) };
  const plan = (id = "1") => JSON.parse(readFileSync(join(home, "plans", `${id}.json`), "utf8")) as Plan;
  const steps = (body: unknown) => {
    const f = join(home, "steps.json");
    writeFileSync(f, JSON.stringify(body));
    return f;
  };
  return { home, me, fc, lines, deps, plan, steps };
}

const GAS = "https://docs.pharos.xyz/getting-started/gas-model";
const TRANSFER = "Transfer(address indexed from,address indexed to,uint256 value)";

describe("planning from the docs", () => {
  it("starts a plan with the docs answer and its sources", async () => {
    const t = setup();
    assert.equal(await main(["ask", "how do i send a transaction on pharos without overpaying for gas?"], t.deps), 0);
    const p = t.plan();
    assert.equal(p.covered, true);
    assert.ok(p.sources.some((s) => normUrl(s.url) === normUrl(GAS)));
    assert.match(t.lines.join("\n"), /sources:\n {2}\[1\]/);
  });

  it("says so when the docs don't cover it, and won't take steps or run", async () => {
    const t = setup(fixture("ask-spending-limit.txt"));
    assert.equal(await main(["ask", "how do i set a daily spending limit on my agent's wallet on pharos?"], t.deps), 3);
    assert.match(t.lines.join("\n"), /NOT IN THE DOCS/);
    const f = t.steps({ steps: [{ title: "x", source: GAS, read: { gas_price: {} } }] });
    assert.equal(await main(["steps", "1", f], t.deps), 3);
    assert.equal(await main(["run", "1"], t.deps), 3);
    assert.equal(t.plan().steps.length, 0);
  });

  it("refuses a step that cites a page nobody read for this plan", async () => {
    const t = setup();
    await main(["ask", "q"], t.deps);
    const f = t.steps({ steps: [{ title: "x", source: "https://docs.pharos.xyz/developer-guide/x402", read: { gas_price: {} } }] });
    assert.equal(await main(["steps", "1", f], t.deps), 2);
    assert.equal(t.plan().steps.length, 0);
    // Once the page is read for the plan, the same step is fine.
    await main(["page", "https://docs.pharos.xyz/developer-guide/x402.md", "--plan", "1"], t.deps);
    assert.equal(await main(["steps", "1", f], t.deps), 0);
  });

  it("treats spellings of the same docs page as one", () => {
    assert.equal(normUrl("https://docs.pharos.xyz//getting-started/gas-model.md#x"), normUrl(GAS));
    assert.equal(normUrl("/getting-started/gas-model/"), normUrl(GAS));
  });
});

describe("doing it", () => {
  const gasPlan = (expectOn: "gas_limit" | "gas_used") => ({
    steps: [
      { title: "gas price", source: GAS, read: { gas_price: {} }, expect: [{ equals: "10" }] },
      { title: "send 0.001 PROS to bob", source: GAS, tx: { to: BOB, value_pros: "0.001" }, expect: [{ status: "success" }, { fee_charged_on: expectOn }] },
    ],
  });

  it("prepares the transaction and sends nothing without --yes", async () => {
    const t = setup();
    await main(["ask", "q"], t.deps);
    await main(["steps", "1", t.steps(gasPlan("gas_used"))], t.deps);
    assert.equal(await main(["run", "1"], t.deps), 0);
    assert.equal(t.fc.sent.length, 0);
    const run = t.plan().runs[0];
    assert.equal(run.outcome, "prepared");
    assert.match(run.results[1].prepared!.gas, /estimate 50,000, limit 60,000 \(\+20%\)/);
  });

  it("signs, sends, and reports success when the chain matches the plan", async () => {
    const t = setup();
    await main(["ask", "q"], t.deps);
    await main(["steps", "1", t.steps(gasPlan("gas_used"))], t.deps);
    assert.equal(await main(["run", "1", "--yes"], t.deps), 0);
    assert.equal(t.fc.sent.length, 1);
    const tx = parseTransaction(t.fc.sent[0]);
    assert.equal(tx.chainId, 1672);
    assert.equal(tx.gas, 60_000n);
    assert.equal(t.plan().runs[0].outcome, "success");
  });

  it("reports failure when the chain doesn't do what the docs said", async () => {
    const t = setup();
    await main(["ask", "q"], t.deps);
    await main(["steps", "1", t.steps(gasPlan("gas_limit"))], t.deps);
    assert.equal(await main(["run", "1", "--yes"], t.deps), 4);
    const out = t.lines.join("\n");
    assert.match(out, /FAIL fee charged on the gas limit: paid 0\.0004 PROS/);
    assert.match(out, /OUTCOME {2}failure/);
  });

  it("checks a token payment by its event and both balances", async () => {
    const t = setup();
    await main(["ask", "q"], t.deps);
    const body = {
      steps: [{
        title: "pay bob 0.25 USDC",
        source: GAS,
        tx: { to: USDC, sig: "transfer(address to,uint256 amount)", args: [BOB, "250000"] },
        expect: [
          { event: { address: USDC, event: TRANSFER, args: { from: "self", to: BOB, value: "250000" } } },
          { erc20_delta: { token: USDC, holder: "self", amount: "-0.25" } },
          { erc20_delta: { token: USDC, holder: BOB, amount: "0.25" } },
        ],
      }],
    };
    await main(["steps", "1", t.steps(body)], t.deps);
    assert.equal(await main(["run", "1", "--yes"], t.deps), 0, t.lines.join("\n"));
    assert.ok(t.plan().runs[0].results[0].checks.every((c) => c.ok));
  });

  it("won't send more PROS than max_pros_per_tx", async () => {
    const t = setup();
    await main(["ask", "q"], t.deps);
    await main(["steps", "1", t.steps({ steps: [{ title: "big", source: GAS, tx: { to: BOB, value_pros: "5" } }] })], t.deps);
    assert.equal(await main(["run", "1", "--yes"], t.deps), 4);
    assert.equal(t.fc.sent.length, 0);
    assert.match(t.plan().runs[0].results[0].error!, /max_pros_per_tx/);
  });
});
