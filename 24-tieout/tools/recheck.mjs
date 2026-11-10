// Re-checks a tieout report with none of tieout's own code: plain fetch to the Pharos RPC, the two CSV files and
// nothing else. For every asset in the books file it reads the opening and closing balance at the blocks written in
// the file, and it re-adds the transactions file to see the in, out and gas columns match the books.
//
//   node tools/recheck.mjs <wallet> <report>-books.csv <report>.csv
import { readFileSync } from "node:fs";

const [wallet, booksPath, txPath] = process.argv.slice(2);
if (!wallet || !booksPath || !txPath) {
  console.log("usage: node tools/recheck.mjs <wallet> <report>-books.csv <report>.csv");
  process.exit(1);
}
const RPC = process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz";

// minimal CSV reader: our files quote a cell only when it has a comma, a quote or a newline
function readCsv(path) {
  const text = readFileSync(path, "utf8");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else cell += ch;
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// the public RPC answers "Request too fast per second" when pushed, so back off and ask again
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await res.json();
    if (!body.error) return body.result;
    if (attempt < 6 && /too fast|limit/i.test(body.error.message)) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    throw new Error(`${method}: ${body.error.message}`);
  }
}

const hex = (n) => "0x" + BigInt(n).toString(16);
const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
// "1.5" with 6 decimals -> 1500000n
const units = (s, d) => {
  const neg = s.startsWith("-");
  const [w, f = ""] = s.replace("-", "").split(".");
  const v = BigInt(w + f.padEnd(d, "0").slice(0, d));
  return neg ? -v : v;
};

async function balance(token, block) {
  if (!token) return BigInt(await rpc("eth_getBalance", [wallet, hex(block)]));
  const r = await rpc("eth_call", [{ to: token, data: "0x70a08231" + pad(wallet) }, hex(block)]);
  return r === "0x" ? 0n : BigInt(r);
}
async function decimals(token) {
  if (!token) return 18;
  return Number(BigInt(await rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"])));
}

const books = readCsv(booksPath);
const txs = readCsv(txPath);
let bad = 0;
console.log(`wallet ${wallet}, opening block ${books[0]?.opening_block}, closing block ${books[0]?.closing_block}, rpc ${RPC}`);
console.log("asset | opening (file / chain) | closing (file / chain) | in, out, gas re-added from the transactions file");
for (const b of books) {
  const token = b.token_address || null;
  const d = await decimals(token);
  const [open, close] = await Promise.all([balance(token, b.opening_block), balance(token, b.closing_block)]);
  const mine = txs.filter((t) => (t.token_address || null)?.toLowerCase() === token?.toLowerCase() && t.asset === b.asset);
  const sum = (dir) => mine.filter((t) => t.direction === dir).reduce((s, t) => s + units(t.amount, d), 0n);
  const gas = token ? 0n : txs.reduce((s, t) => s + (t.gas_fee_pros ? units(t.gas_fee_pros, 18) : 0n), 0n);
  const checks = [
    units(b.opening, d) === open,
    units(b.closing_on_chain, d) === close,
    units(b.in, d) === sum("in"),
    units(b.out, d) === sum("out"),
    units(b.gas, d) === gas,
  ];
  const ok = checks.every(Boolean);
  if (!ok) bad++;
  console.log(
    `${ok ? "ok  " : "DIFF"} ${b.asset} | ${b.opening} / ${open === units(b.opening, d) ? "same" : open} | ${b.closing_on_chain} / ${close === units(b.closing_on_chain, d) ? "same" : close} | ${checks.slice(2).every(Boolean) ? "same" : "different"} | books say ties=${b.ties}`,
  );
}
console.log(bad ? `${bad} asset(s) disagree with the chain or with the transactions file` : `all ${books.length} assets agree with the chain and with the transactions file`);
process.exit(bad ? 1 : 0);
