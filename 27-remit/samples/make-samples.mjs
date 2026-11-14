// Rebuilds the sample invoices: `node samples/make-samples.mjs` from 27-remit (needs the dev dependencies).
// The PDF and the PNGs are generated rather than drawn by hand so anyone can see exactly what is inside them.
//
// Every valid sample pays 0xa991…4348, the x402 seller wallet from task 12 of this repo, and asks for cents, so a
// real run with a small test wallet can go all the way to a mined payment.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import QRCode from "qrcode";

const PAYEE = "0xa991B44106b336B547259bD2B9b2f45931414348";
const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const here = (f) => new URL(f, import.meta.url);

const json = (f, o) => writeFileSync(here(f), JSON.stringify(o, null, 2) + "\n");

json("01-hosting.json", {
  invoiceNumber: "INV-2026-1107",
  issueDate: "2026-11-14",
  dueDate: "2026-12-14",
  issuer: "Lighthouse RPC (sample)",
  payee: PAYEE,
  currency: "USDC",
  items: [
    { description: "Dedicated RPC endpoint, November", quantity: 1, unitPrice: 0.25, amount: 0.25 },
    { description: "WebSocket add-on", quantity: 1, unitPrice: 0.05, amount: 0.05 },
  ],
  subtotal: 0.3,
  tax: 0,
  total: 0.3,
});

writeFileSync(
  here("02-freelance.md"),
  `# Invoice

Invoice #: INV-2026-0419
Date: 2026-11-14
Due Date: 2026-12-15

Pay to (Pharos): ${PAYEE}

| Work | Amount |
|---|---|
| Contract review, two files | 0.0030 PROS |
| Gas notes | 0.0010 PROS |

Subtotal: 0.0040 PROS
Tax: 0.0000 PROS
Total: 0.0040 PROS

Thanks! Paid in PROS on Pharos mainnet, please keep the invoice number in the payment.
`,
);

// A real (tiny) PDF: one page, Helvetica, one deflated content stream, a correct xref table.
function pdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const body = ["BT", "/F1 12 Tf", "15 TL", "56 780 Td", ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n");
  const stream = deflateSync(Buffer.from(body, "latin1"));
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [];
  let size = parts[0].length;
  const push = (b) => (parts.push(b), (size += b.length));
  objs.forEach((o, i) => (offsets.push(size), push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, "latin1"))));
  offsets.push(size);
  push(Buffer.from(`5 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"));
  push(stream);
  push(Buffer.from("\nendstream\nendobj\n", "latin1"));
  const xref = size;
  push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

writeFileSync(
  here("03-audit.pdf"),
  pdf([
    "Harborline Security (sample)",
    "",
    "Invoice #: INV-2026-0118",
    "Date: 2026-11-14",
    "Due Date: 2026-12-20",
    `Pay to: ${PAYEE}`,
    "",
    "Retest of two findings      0.15 USDC",
    "",
    "Total: 0.15 USDC",
  ]),
);

const qr = (f, text) => QRCode.toFile(here(f).pathname.replace(/^\/([A-Za-z]:)/, "$1"), text, { width: 360, margin: 2 });
await qr("04-checkout-qr.png", `ethereum:${USDC}@1672/transfer?address=${PAYEE}&uint256=100000&ref=INV-2026-QR-0042`);

json("05-totals-disagree.json", {
  invoiceNumber: "INV-2026-0920",
  dueDate: "2026-12-01",
  payee: PAYEE,
  currency: "USDC",
  items: [
    { description: "Indexer, tier 1", amount: 0.8 },
    { description: "Archive add-on", amount: 0.4 },
  ],
  subtotal: 1.2,
  tax: 0,
  total: 0.9,
});

writeFileSync(here("06-no-reference.txt"), `INVOICE\n\nDate: 2026-11-14\nPay to: ${PAYEE}\nTotal: 0.25 PROS\n\n(the issuer forgot the invoice number)\n`);

json("07-just-dollars.json", { invoiceNumber: "INV-2026-0077", payee: PAYEE, currency: "$", amount: 2.5 });

// one digit changed at the end: the mixed-case checksum no longer fits, which is how a typo gets caught
writeFileSync(here("08-typo-in-address.txt"), `Invoice #: INV-2026-0880\nPay to: ${PAYEE.slice(0, -1)}9\nTotal: 0.10 USDC\n`);

writeFileSync(
  here("09-tutorial-address.txt"),
  "Invoice #: INV-2026-0901\nPay to: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8\nTotal: 0.10 USDC\n\n(copied from a Hardhat tutorial: account #1)\n",
);

await qr("10-ethereum-qr.png", `ethereum:${USDC}@1/transfer?address=${PAYEE}&uint256=100000&ref=INV-2026-QR-0043`);

console.log("samples written");
