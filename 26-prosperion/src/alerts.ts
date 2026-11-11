// Launch alerts in two waves. Wave one is facts the code read from the chain, sent the moment the launch is
// checked, with a link that opens the signing page in your wallet. Wave two is the agent's write-up, sent as a reply
// when it is ready. The agent can be slow or down; wave one never waits for it.
import { formatEther } from "viem";
import { EXPLORER } from "./chain.js";
import { requestUrl, walletLinks } from "./links.js";
import { PHASE_NAME } from "./market.js";
import type { Launch, Store, Watch } from "./store.js";

export interface Wave1Extras {
  url: string;
  links: ReturnType<typeof walletLinks>;
}
export interface PushChannel {
  sendWave1: (chatId: number, text: string, extras?: Wave1Extras) => Promise<number>;
  sendWave2: (chatId: number, replyTo: number, text: string) => Promise<void>;
}
export interface AlertDeps {
  telegram: PushChannel;
  askAgent: (prompt: string) => Promise<string>;
  agentTimeoutMs: number;
}

// Slippage floor baked into the request: the page re-quotes at signing time and asks for at least 98% of it.
const MIN_OUT_BPS = 9800;

export function wantsThis(w: Watch, l: Launch): boolean {
  const c = l.checks;
  return !!c && c.genuine && c.phase === 0 && c.reserveBefore <= w.maxReserveBeforeWei;
}

export function factsText(l: Launch, w: Watch, url: string): string {
  const c = l.checks!;
  const pros = (x: bigint) => `${Number(formatEther(x)).toLocaleString("en-US", { maximumFractionDigits: 4 })} PROS`;
  return [
    `<b>New Prosper launch</b> at block ${c.block}`,
    `Market <code>${l.market}</code> (checked against Prosper's factory: genuine)`,
    `Phase: ${PHASE_NAME[c.phase] ?? c.phase}. Already in the curve: ${pros(c.reserveBefore)}${c.reserveBefore === 0n ? " (nobody bought yet)" : ""}`,
    `Your limit: ${pros(w.maxPerBuyWei)} per buy. Quote for that: ${(Number(c.quoteOut) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens`,
    `Market code: <code>${c.implNow}</code>`,
    "",
    `Sign it yourself: ${url}`,
    `Creation tx: ${EXPLORER}/tx/${l.tx}`,
    "The page checks everything again right before your wallet opens. The agent's take follows.",
  ].join("\n");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("agent took too long")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export function dossierPrompt(l: Launch): string {
  return [
    `A new Prosper market was just created: market ${l.market}, vault ${l.vault}, pToken ${l.pToken}, block ${l.block}.`,
    "Write a short dossier for someone deciding whether to buy in first:",
    "who runs the vault and what is behind its NAV (vault_picture), whether the market is genuine and how much PROS is",
    "already in (market_check), and anything that should make them hesitate. Quote the block for every number.",
    "Plain text, under 900 characters. Do not tell them to buy; give facts and risks.",
  ].join(" ");
}

export async function onLaunch(l: Launch, store: Store, deps: AlertDeps): Promise<void> {
  store.saveLaunch(l);
  const targets = store.allWatches().filter((w) => w.telegramChatId !== undefined && wantsThis(w, l));
  if (targets.length === 0) return;

  // Wave one: facts and a link, to everyone, now.
  const sent: { chatId: number; msgId: number }[] = [];
  for (const w of targets) {
    const id = store.saveRequest({
      kind: "buy",
      createdBlock: l.checks!.block,
      params: {
        market: l.market,
        amountWei: w.maxPerBuyWei.toString(),
        minOutBps: MIN_OUT_BPS,
        maxReserveBeforeWei: w.maxReserveBeforeWei.toString(),
        acceptedImpl: l.checks!.implNow,
        owner: w.address,
      },
    });
    const url = requestUrl(id);
    try {
      const msgId = await deps.telegram.sendWave1(w.telegramChatId!, factsText(l, w, url), { url, links: walletLinks(url) });
      sent.push({ chatId: w.telegramChatId!, msgId });
    } catch (e) {
      console.error(`[alerts] wave 1 to ${w.telegramChatId} failed: ${(e as Error).message}`);
    }
  }

  // Wave two: one dossier per launch, shared by everyone who got wave one.
  let dossier: string;
  try {
    dossier = await withTimeout(deps.askAgent(dossierPrompt(l)), deps.agentTimeoutMs);
    store.logDecision({ at: Date.now(), kind: "verdict", subject: l.market, reason: dossier, block: l.checks!.block });
  } catch (e) {
    dossier = `Agent unavailable right now (${(e as Error).message}). The facts above were read from the chain at block ${l.checks!.block}.`;
  }
  for (const s of sent) {
    await deps.telegram.sendWave2(s.chatId, s.msgId, dossier).catch((e) =>
      console.error(`[alerts] wave 2 to ${s.chatId} failed: ${(e as Error).message}`));
  }
}
