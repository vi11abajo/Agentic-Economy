// A small PDF writer, just enough for this report: text, tables that wrap and break across pages, thin rules and
// clickable links. Hand-rolled on purpose: the skill ships as one bundled .mjs, and the usual PDF libraries read
// their font files from disk at runtime, which a bundle doesn't carry. The 14 standard PDF fonts need no files.
import { EXPLORER_ADDRESS, EXPLORER_TX } from "./chain.js";
import { fingerprint } from "./csv.js";
import { CATEGORY_ORDER, CATEGORY_TITLE, NATIVE } from "./ledger.js";
import { UNLIMITED, formatAmount, nameOf, type Report } from "./report.js";
import { ties } from "./tieout.js";
import { amountOf, describe, summary, when, zoneName } from "./words.js";

// A4 landscape: the tie-out table has eight number columns and they need the width.
const W = 842;
const H = 595;
const M = 40;
const INNER = W - 2 * M;

// Helvetica advance widths for ASCII 32..126 (from the standard AFM), in 1/1000 em.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

type Font = "F1" | "F2";

// Anything outside WinAnsi gets a plain stand-in rather than a broken glyph.
const winAnsi = (s: string) =>
  s
    .replace(/✔/g, "OK")
    .replace(/✘/g, "X")
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e…]/g, "?");

function width(s: string, size: number, font: Font): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += ch === "…" ? 1000 : HELV[c - 32] ?? 556;
  }
  return (w / 1000) * size * (font === "F2" ? 1.07 : 1);
}

function wrap(text: string, max: number, size: number, font: Font): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n").map(winAnsi)) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (width(next, size, font) <= max) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      // a single word wider than the column (a long number, a hash) is cut where it has to be
      let rest = word;
      while (width(rest, size, font) > max) {
        let cut = rest.length - 1;
        while (cut > 1 && width(rest.slice(0, cut), size, font) > max) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

const pdfString = (s: string) => "(" + s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/…/g, "\\205") + ")";

interface Page {
  ops: string[];
  links: { x: number; y: number; w: number; h: number; url: string }[];
}

export interface Cell {
  text: string;
  url?: string;
  bold?: boolean;
}

class Doc {
  pages: Page[] = [];
  y = 0;
  constructor() {
    this.newPage();
  }
  get page() {
    return this.pages[this.pages.length - 1];
  }
  newPage() {
    this.pages.push({ ops: [], links: [] });
    this.y = H - M;
  }
  need(h: number) {
    if (this.y - h < M) this.newPage();
  }
  text(x: number, y: number, s: string, size: number, font: Font, gray = 0) {
    this.page.ops.push(`BT ${gray} g /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(s)} Tj ET`);
  }
  rule(y: number, gray = 0.8) {
    this.page.ops.push(`${gray} G 0.5 w ${M} ${y.toFixed(2)} m ${W - M} ${y.toFixed(2)} l S`);
  }
  heading(s: string, size = 14) {
    this.need(size + 18);
    this.y -= size + 8;
    this.text(M, this.y, winAnsi(s), size, "F2");
    this.y -= 6;
  }
  paragraph(s: string, size = 9.5) {
    for (const line of wrap(s, INNER, size, "F1")) {
      this.need(size + 4);
      this.y -= size + 3;
      this.text(M, this.y, line, size, "F1");
    }
    this.y -= 5;
  }
  /** widths are fractions of the inner width; `right` marks number columns */
  table(head: string[], rows: Cell[][], widths: number[], right: boolean[] = [], size = 8) {
    const cols = widths.map((f) => f * INNER);
    const lead = size + 2.5;
    const draw = (cells: Cell[], bold: boolean) => {
      const wrapped = cells.map((c, i) => wrap(c.text, cols[i] - 6, size, bold || c.bold ? "F2" : "F1"));
      const h = Math.max(...wrapped.map((l) => l.length)) * lead + 4;
      if (this.y - h < M) {
        this.newPage();
        if (!bold) draw(head.map((t) => ({ text: t })), true);
      }
      let x = M;
      wrapped.forEach((lines, i) => {
        const font: Font = bold || cells[i].bold ? "F2" : "F1";
        lines.forEach((line, k) => {
          const ly = this.y - (k + 1) * lead + 1;
          const lx = right[i] ? x + cols[i] - 3 - width(line, size, font) : x + 3;
          this.text(lx, ly, line, size, font, bold ? 0.25 : 0);
          if (cells[i].url) this.page.links.push({ x: lx, y: ly - 2, w: width(line, size, font), h: size + 2, url: cells[i].url! });
        });
        x += cols[i];
      });
      this.y -= h;
      this.rule(this.y, bold ? 0.4 : 0.85);
    };
    this.need(lead * 2 + 8);
    draw(head.map((t) => ({ text: t })), true);
    for (const r of rows) draw(r, false);
    this.y -= 8;
  }
  bytes(): Buffer {
    const objs: string[] = [];
    const add = (body: string) => objs.push(body) && objs.length;
    add("<< /Type /Catalog /Pages 2 0 R >>");
    add("PAGES");
    const font = (base: string) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
    const f1 = font("Helvetica");
    const f2 = font("Helvetica-Bold");
    const kids: number[] = [];
    this.pages.forEach((p, i) => {
      const footer = `BT 0.5 g /F1 7 Tf ${M} 22 Td ${pdfString(`page ${i + 1} of ${this.pages.length}`)} Tj ET`;
      const stream = [...p.ops, footer].join("\n");
      const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      const annots = p.links.map((l) =>
        add(`<< /Type /Annot /Subtype /Link /Rect [${l.x.toFixed(2)} ${l.y.toFixed(2)} ${(l.x + l.w).toFixed(2)} ${(l.y + l.h).toFixed(2)}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(l.url)} >> >>`),
      );
      kids.push(
        add(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(" ")}]` : ""} >>`,
        ),
      );
    });
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}

export function pdf(r: Report, generatedAt: Date): Buffer {
  const d = new Doc();
  const amt = (asset: string, v: bigint) => formatAmount(v, r.assets.get(asset)?.decimals ?? 18);
  d.heading("Wallet activity report", 18);
  d.paragraph(`Wallet ${r.wallet} on Pharos mainnet (chain 1672)`);
  d.paragraph(
    `Period ${when(r, r.period.from).slice(0, 16)} to ${when(r, r.period.to).slice(0, 16)} (${zoneName(r)}). Opening state after block ${r.openBlock} (${when(r, r.openBlockTime)}), closing state after block ${r.closeBlock} (${when(r, r.closeBlockTime)}).`,
  );

  d.heading("Summary");
  for (const p of summary(r)) d.paragraph(p);

  d.heading("Does it add up");
  d.table(
    ["Asset", "Opening", "In", "Out", "Gas", "Expected closing", "Closing on chain", "Result"],
    r.books.map((l) => [
      { text: r.assets.get(l.asset)?.label ?? l.asset, url: l.asset === NATIVE ? undefined : EXPLORER_ADDRESS + l.asset },
      { text: amt(l.asset, l.opening) },
      { text: amt(l.asset, l.in) },
      { text: amt(l.asset, l.out) },
      { text: l.fees ? amt(l.asset, l.fees) : "" },
      { text: amt(l.asset, l.expected) },
      { text: amt(l.asset, l.closing) },
      { text: l.gap === null ? "can't check" : ties(l) ? "ties" : `off by ${amt(l.asset, l.gap)}`, bold: l.gap !== 0n },
    ]),
    [0.1, 0.145, 0.135, 0.135, 0.09, 0.145, 0.145, 0.105],
    [false, true, true, true, true, true, true, false],
    7.5,
  );

  d.heading("Totals by category");
  d.table(
    ["Category", "Transactions", "In", "Out", "Gas paid"],
    r.totals.map((t) => {
      const side = (dir: "in" | "out") =>
        [...t.moved]
          .filter(([, m]) => m[dir] > 0n)
          .map(([a, m]) => amountOf(r, a, m[dir]))
          .join("\n");
      return [{ text: CATEGORY_TITLE[t.category] }, { text: String(t.count) }, { text: side("in") }, { text: side("out") }, { text: t.fees ? amountOf(r, NATIVE, t.fees) : "" }];
    }),
    [0.2, 0.1, 0.27, 0.27, 0.16],
    [false, true, false, false, true],
  );

  d.heading("Worth a second look");
  if (!r.notables.length) d.paragraph("Nothing stood out.");
  else
    d.table(
      ["Why", "Link"],
      r.notables.map((n) => [
        { text: n.why },
        n.hash ? { text: n.hash.slice(0, 18) + "…", url: EXPLORER_TX + n.hash } : n.address ? { text: nameOf(r, n.address), url: EXPLORER_ADDRESS + n.address } : { text: "" },
      ]),
      [0.8, 0.2],
    );

  if (r.approvals.length) {
    d.heading("Approvals given in the period");
    d.table(
      ["Token", "Spender", "Given", "Left at the end", "Tx"],
      r.approvals.map((a) => {
        const fmt = (v: bigint | null) => (v === null ? "unknown" : v >= UNLIMITED ? "unlimited" : formatAmount(v, r.assets.get(a.token)?.decimals ?? 18));
        return [
          { text: r.assets.get(a.token)?.label ?? nameOf(r, a.token), url: EXPLORER_ADDRESS + a.token },
          { text: nameOf(r, a.spender), url: EXPLORER_ADDRESS + a.spender },
          { text: fmt(a.given) },
          { text: fmt(a.left) },
          { text: a.hash.slice(0, 18) + "…", url: EXPLORER_TX + a.hash },
        ];
      }),
      [0.18, 0.27, 0.15, 0.15, 0.25],
      [false, false, true, true, false],
    );
  }

  for (const c of CATEGORY_ORDER) {
    const list = r.entries.filter((e) => e.category === c);
    if (!list.length) continue;
    d.heading(`${CATEGORY_TITLE[c]} (${list.length})`, 12);
    d.table(
      [`Time (${zoneName(r)})`, "What happened", "Gas (PROS)", "Tx"],
      list.map((e) => [{ text: when(r, e.time) }, { text: describe(r, e) }, { text: e.mine ? formatAmount(e.fee, 18) : "" }, { text: e.hash.slice(0, 18) + "…", url: EXPLORER_TX + e.hash }]),
      [0.15, 0.55, 0.1, 0.2],
      [false, false, true, false],
    );
  }

  d.heading("How this was put together", 12);
  d.paragraph(
    `The explorer (socialscan) is only an index of which transactions touched the wallet. Token amounts and gas come from each transaction's receipt, native PROS from the transaction value and internal calls. Balances are read with eth_getBalance and balanceOf at blocks ${r.openBlock} and ${r.closeBlock} on Pharos RPC.`,
  );
  d.paragraph(`Generated ${generatedAt.toISOString().replace(/\.\d+Z$/, "Z")} by tieout. Fingerprint of the data: ${fingerprint(r)} (same wallet and period give the same fingerprint).`);
  return d.bytes();
}
