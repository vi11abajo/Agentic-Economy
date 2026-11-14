// The summary across all watched whales: what each holds right now, what moved in the window, the significant
// moves told in words, and one line for the whole group.
import { formatEther, formatUnits, type Address, type PublicClient } from "viem";
import { explain, fmt, moveUsd, netLegs, unitUsd, type Context, type Story, type Whale } from "./explain.js";
import { history, type Move } from "./history.js";
import { ABI, MULTICALL3, USDC, WPROS, addressLink, short, type Get } from "./pharos.js";
import type { WatchList } from "./whales.js";

export interface WhaleReport {
  whale: Whale;
  holds: { pros: number; usdc: number; wpros: number; usd: number };
  moves: number;
  inUsd: number;
  outUsd: number;
  stance: "adding" | "taking out" | "quiet" | "even";
  last?: string;
  stories: Story[]; // significant moves, newest first
  partners: Partner[]; // who it moved the most with, both ways
  error?: string;
}

export interface Partner {
  address: string;
  label: string;
  inUsd: number;
  outUsd: number;
  moves: number;
}

export interface Report {
  at: string;
  since: string;
  hours: number;
  prosUsd: number;
  feedUpdated: string;
  whales: WhaleReport[];
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const signed = (n: number) => `${n >= 0 ? "+" : "-"}${usd(Math.abs(n))}`;

async function holdings(client: PublicClient, whales: Whale[], pros: number) {
  const calls = whales.flatMap((w) => [
    { address: MULTICALL3, abi: ABI, functionName: "getEthBalance", args: [w.address as Address] },
    { address: USDC, abi: ABI, functionName: "balanceOf", args: [w.address as Address] },
    { address: WPROS, abi: ABI, functionName: "balanceOf", args: [w.address as Address] },
  ]);
  const res = await client.multicall({ contracts: calls as never, multicallAddress: MULTICALL3, allowFailure: false });
  return whales.map((_, i) => {
    const [p, u, w] = (res as bigint[]).slice(i * 3, i * 3 + 3);
    const h = { pros: Number(formatEther(p)), usdc: Number(formatUnits(u, 6)), wpros: Number(formatEther(w)) };
    return { ...h, usd: (h.pros + h.wpros) * pros + h.usdc };
  });
}

/** The two addresses this whale moved the most value with, adding up both directions. */
function partners(moves: Move[], pros: number, watched: Map<string, Whale>): Partner[] {
  const by = new Map<string, Partner>();
  for (const m of moves) {
    const { outs, ins } = netLegs(m);
    for (const [x, dir] of [...outs.map((o) => [o, "out"] as const), ...ins.map((i) => [i, "in"] as const)]) {
      const a = x.party.address;
      const p = by.get(a) ?? { address: a, label: watched.get(a)?.label ?? (x.party.name ? `${x.party.name} ${short(a)}` : `${x.party.contract ? "contract" : "wallet"} ${short(a)}`), inUsd: 0, outUsd: 0, moves: 0 };
      const v = x.amount * (unitUsd(x, pros) ?? 0);
      if (dir === "in") p.inUsd += v;
      else p.outUsd += v;
      p.moves++;
      by.set(a, p);
    }
  }
  return [...by.values()].filter((p) => p.inUsd + p.outUsd > 0).sort((a, b) => b.inUsd + b.outUsd - (a.inUsd + a.outUsd)).slice(0, 2);
}

/** In and out in dollars over every move in the window, not just the significant ones. */
function flows(moves: Move[], pros: number): { inUsd: number; outUsd: number } {
  let inUsd = 0;
  let outUsd = 0;
  for (const m of moves) {
    const { outs, ins } = netLegs(m);
    for (const x of ins) inUsd += x.amount * (unitUsd(x, pros) ?? 0);
    for (const x of outs) outUsd += x.amount * (unitUsd(x, pros) ?? 0);
  }
  return { inUsd, outUsd };
}

export async function build(client: PublicClient, get: Get, list: WatchList, hours: number, pros: { price: number; updatedAt: number }, now = new Date()): Promise<Report> {
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const watched = new Map(list.whales.map((w) => [w.address, w]));
  const ctx: Context = { client, get, pros: pros.price, watched };
  const holds = await holdings(client, list.whales, pros.price);
  const whales: WhaleReport[] = [];
  for (const [i, whale] of list.whales.entries()) {
    const base = { whale, holds: holds[i], moves: 0, inUsd: 0, outUsd: 0, stance: "quiet" as const, stories: [], partners: [] };
    let moves: Move[];
    try {
      moves = await history(get, whale.address, since);
    } catch (e) {
      whales.push({ ...base, error: `history not available: ${(e as Error).message}` });
      continue;
    }
    const { inUsd, outUsd } = flows(moves, pros.price);
    const line = whale.minUsd ?? list.minUsd;
    const big = moves.filter((m) => (moveUsd(m, pros.price) ?? 0) >= line);
    const stories: Story[] = [];
    for (const m of big) stories.push(await explain(ctx, whale, m));
    const diff = inUsd - outUsd;
    const stance = moves.length === 0 ? "quiet" : Math.abs(diff) < Math.max(inUsd, outUsd) * 0.05 ? "even" : diff > 0 ? "adding" : "taking out";
    whales.push({ whale, holds: holds[i], moves: moves.length, inUsd, outUsd, stance, last: moves[0]?.time, stories, partners: partners(moves, pros.price, watched) });
  }
  return { at: now.toISOString(), since, hours, prosUsd: pros.price, feedUpdated: new Date(pros.updatedAt * 1000).toISOString(), whales };
}

function totals(r: Report) {
  const all = r.whales.flatMap((w) => w.stories);
  const biggest = all.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];
  return {
    holds: r.whales.reduce((s, w) => s + w.holds.usd, 0),
    inUsd: r.whales.reduce((s, w) => s + w.inUsd, 0),
    outUsd: r.whales.reduce((s, w) => s + w.outUsd, 0),
    moves: r.whales.reduce((s, w) => s + w.moves, 0),
    significant: all.length,
    active: r.whales.filter((w) => w.moves > 0).length,
    biggest,
  };
}

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export function storyLines(s: Story, indent = "  "): string[] {
  return [
    `${indent}${when(s.move.time)}  ${s.headline}${s.usd !== undefined ? `  (${usd(s.usd)})` : ""}`,
    ...s.why.map((w) => `${indent}    ${w}`),
    `${indent}    ${s.links[0][1]}`,
  ];
}

export function text(r: Report): string {
  const t = totals(r);
  const out = [
    `sonar · ${r.whales.length} whales · last ${r.hours} h (since ${when(r.since)} UTC) · PROS/USD $${r.prosUsd.toFixed(4)} (feed, updated ${when(r.feedUpdated)})`,
    "",
  ];
  for (const w of r.whales) {
    out.push(`${w.whale.label}  ${short(w.whale.address)}`);
    out.push(`  holds ${fmt(w.holds.pros)} PROS + ${fmt(w.holds.usdc)} USDC + ${fmt(w.holds.wpros)} WPROS ≈ ${usd(w.holds.usd)}`);
    if (w.error) out.push(`  ${w.error}`);
    else if (!w.moves) out.push(`  nothing moved in the window`);
    else out.push(`  ${w.moves} move${w.moves === 1 ? "" : "s"}, ${w.stories.length} significant · in ${usd(w.inUsd)} · out ${usd(w.outUsd)} · net ${signed(w.inUsd - w.outUsd)} · ${w.stance} · last ${when(w.last!)}`);
    for (const p of w.partners) out.push(`  most with ${p.label}: out ${usd(p.outUsd)}, in ${usd(p.inUsd)} over ${p.moves} move${p.moves === 1 ? "" : "s"}`);
    for (const s of w.stories.slice(0, 5)) out.push(...storyLines(s));
    if (w.stories.length > 5) out.push(`  … ${w.stories.length - 5} more significant moves (see --json)`);
    out.push("");
  }
  out.push(`all watched: hold ≈ ${usd(t.holds)} · ${t.active} of ${r.whales.length} moved · ${t.moves} moves, ${t.significant} significant · in ${usd(t.inUsd)} · out ${usd(t.outUsd)} · net ${signed(t.inUsd - t.outUsd)}`);
  if (t.biggest) out.push(`biggest: ${t.biggest.whale.label} ${t.biggest.headline} (${usd(t.biggest.usd ?? 0)}) ${t.biggest.links[0][1]}`);
  return out.join("\n");
}

export function markdown(r: Report): string {
  const t = totals(r);
  const out = [
    `# Whale report, ${when(r.at)} UTC`,
    "",
    `Last ${r.hours} hours. PROS/USD $${r.prosUsd.toFixed(4)} from the Chainlink feed (updated ${when(r.feedUpdated)} UTC). Dollar values of PROS and WPROS use that price.`,
    "",
    "| whale | holds now | moves | significant | in | out | net | stance |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
    ...r.whales.map((w) => `| [${w.whale.label}](${addressLink(w.whale.address)}) | ${usd(w.holds.usd)} | ${w.moves} | ${w.stories.length} | ${usd(w.inUsd)} | ${usd(w.outUsd)} | ${signed(w.inUsd - w.outUsd)} | ${w.error ? "no data" : w.stance} |`),
    `| **all watched** | **${usd(t.holds)}** | **${t.moves}** | **${t.significant}** | **${usd(t.inUsd)}** | **${usd(t.outUsd)}** | **${signed(t.inUsd - t.outUsd)}** | |`,
    "",
  ];
  for (const w of r.whales.filter((x) => x.stories.length)) {
    out.push(`## ${w.whale.label}`, "");
    for (const p of w.partners) out.push(`Most with ${p.label}: out ${usd(p.outUsd)}, in ${usd(p.inUsd)} over ${p.moves} moves.`, "");
    for (const s of w.stories) {
      out.push(`- **${when(s.move.time)}** ${s.headline}${s.usd !== undefined ? ` (${usd(s.usd)})` : ""} · [tx](${s.links[0][1]})`);
      for (const y of s.why) out.push(`  - ${y}`);
    }
    out.push("");
  }
  return out.join("\n");
}
