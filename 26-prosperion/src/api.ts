// Prosperion's HTTP API, behind nginx at /api/. Reads are open; watches need a signed-in address; chat is open but
// rate limited. The important one is /api/req/:id: a push link opens the sign page, the page asks here, and we
// re-check the market at the current block before handing back a transaction. If anything changed since the alert
// (someone bought first, the market code was upgraded, it left the curve), the answer is a refusal in words and no tx.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { encodeFunctionData, getAddress, isAddress, parseAbi, type Address, type Hex } from "viem";
import { SESSION_COOKIE, SESSION_TTL_MS, newNonce, sessionCookie, verifySiwe } from "./auth.js";
import type { ChatMessage, WalletEnv } from "./agent.js";
import type { MarketCheck } from "./market.js";
import type { Store } from "./store.js";

export const GATE_ABI = parseAbi([
  "function buy(address market, uint256 minOut, uint256 deadline) payable returns (uint256)",
  "function setLimits((uint128 maxPerBuy, uint128 maxPerDay, uint128 maxReserveBefore, address acceptedMarketImpl) l)",
  "function limitsOf(address) view returns (uint128 maxPerBuy, uint128 maxPerDay, uint128 maxReserveBefore, address acceptedMarketImpl)",
]);

export interface GateLimits {
  maxPerBuy: bigint;
  maxPerDay: bigint;
  maxReserveBefore: bigint;
  acceptedMarketImpl: Address;
}
export interface ApiDeps {
  store: Store;
  gate: Address | null;
  check: (market: Address, amountIn: bigint) => Promise<MarketCheck>;
  readLimits: (owner: Address) => Promise<GateLimits | null>;
  readVault: (vault: Address, block?: bigint) => Promise<unknown>;
  listVaults: () => Promise<unknown[]>;
  explainNavMove: (vault: Address, from: bigint, to: bigint) => Promise<unknown>;
  agent: (messages: ChatMessage[], env: WalletEnv, sessionKey: string, signal?: AbortSignal) => Promise<Response>;
  /** The bot's username, or null when whoever runs this copy has not set up their own bot (then no alerts go out). */
  telegramBot: () => string | null;
  perMinute: number;
  dailyCap: number;
  /** unix seconds; injectable for tests */
  now: () => number;
}

const toJson = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(toJson(body));
}
async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
const clientIp = (req: IncomingMessage) =>
  (req.headers["x-real-ip"] as string) ?? (req.headers["cf-connecting-ip"] as string) ?? req.socket.remoteAddress ?? "?";
const cookie = (req: IncomingMessage, name: string) =>
  (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

/** Why a buy request should not go ahead right now, in plain words; undefined if it may. */
export function refusalFor(c: MarketCheck, maxReserveBeforeWei: bigint, acceptedImpl: string): string | undefined {
  if (!c.genuine) return "Not a Prosper market: the factory does not list it.";
  if (c.phase !== 0) return `The market left the curve (phase ${c.phase}); there is nothing to be first into.`;
  if (c.reserveBefore > maxReserveBeforeWei)
    return `No longer first: ${Number(c.reserveBefore) / 1e18} PROS is already in the curve, your limit was ${Number(maxReserveBeforeWei) / 1e18}.`;
  if (c.implNow.toLowerCase() !== acceptedImpl.toLowerCase())
    return `Market code changed since the alert (now ${c.implNow}). Read what changed before agreeing to it again.`;
  return undefined;
}

export function createApi(d: ApiDeps) {
  const minute = new Map<string, { n: number; start: number }>();
  const overMinute = (ip: string) => {
    const now = Date.now();
    const b = minute.get(ip);
    if (!b || now - b.start > 60_000) { minute.set(ip, { n: 1, start: now }); return false; }
    return ++b.n > d.perMinute;
  };
  const signedIn = (req: IncomingMessage) => {
    const t = cookie(req, SESSION_COOKIE);
    return t ? d.store.sessionAddress(t) : null;
  };

  async function buildRequest(id: string) {
    const r = d.store.getRequest(id);
    if (!r) return null;
    if (r.kind !== "buy") return { request: r, freshCheck: null, tx: null, setLimits: null, refusal: "This kind of request is not available yet." };
    const p = r.params as Record<string, string>;
    const market = getAddress(p.market);
    const amount = BigInt(p.amountWei);
    const maxReserve = BigInt(p.maxReserveBeforeWei);
    const fresh = await d.check(market, amount);
    const refusal = refusalFor(fresh, maxReserve, p.acceptedImpl);
    if (refusal) return { request: r, freshCheck: fresh, tx: null, setLimits: null, refusal };
    if (!d.gate) return { request: r, freshCheck: fresh, tx: null, setLimits: null, refusal: "The Prosperion gate is not deployed yet." };

    const owner = getAddress(p.owner);
    const want: GateLimits = {
      maxPerBuy: amount, maxPerDay: amount * 3n, maxReserveBefore: maxReserve, acceptedMarketImpl: getAddress(p.acceptedImpl),
    };
    const have = await d.readLimits(owner);
    const fits = have && have.maxPerBuy >= amount && have.maxReserveBefore >= maxReserve &&
      have.acceptedMarketImpl.toLowerCase() === want.acceptedMarketImpl.toLowerCase();
    const setLimits = fits ? null : {
      to: d.gate, value: "0",
      data: encodeFunctionData({ abi: GATE_ABI, functionName: "setLimits", args: [want] }),
      limits: want,
    };
    const minOut = (fresh.quoteOut * BigInt(Number(p.minOutBps))) / 10_000n;
    const deadline = BigInt(d.now() + 300);
    const tx = {
      to: d.gate, value: amount.toString(),
      data: encodeFunctionData({ abi: GATE_ABI, functionName: "buy", args: [market, minOut, deadline] }) as Hex,
      minOut: minOut.toString(), deadline: deadline.toString(),
    };
    return { request: r, freshCheck: fresh, tx, setLimits };
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "");
      const ip = clientIp(req);
      const seg = path.split("/").filter(Boolean);

      if (req.method === "GET" && seg[0] === "req" && seg[1]) {
        const out = await buildRequest(seg[1]);
        return out ? send(res, 200, out) : send(res, 404, { error: "unknown request" });
      }
      if (req.method === "GET" && seg[0] === "vault" && seg[1] && isAddress(seg[1])) {
        const b = url.searchParams.get("block");
        return send(res, 200, await d.readVault(getAddress(seg[1]), b ? BigInt(b) : undefined));
      }
      if (req.method === "GET" && seg[0] === "navmove" && seg[1] && isAddress(seg[1])) {
        return send(res, 200, await d.explainNavMove(getAddress(seg[1]), BigInt(url.searchParams.get("from") ?? "0"), BigInt(url.searchParams.get("to") ?? "0")));
      }
      if (req.method === "GET" && seg[0] === "market" && seg[1] && isAddress(seg[1])) {
        const amount = BigInt(url.searchParams.get("amountWei") ?? "0");
        return send(res, 200, await d.check(getAddress(seg[1]), amount));
      }
      if (req.method === "GET" && path === "/vaults") return send(res, 200, await d.listVaults());
      if (req.method === "GET" && path === "/launches") return send(res, 200, d.store.listLaunches(30));
      if (req.method === "GET" && path === "/decisions") return send(res, 200, d.store.decisions(50));

      if (req.method === "POST" && path === "/chat") {
        if (overMinute(ip)) return send(res, 429, { error: "Too many messages from you this minute. Give it a moment." });
        const day = new Date(d.now() * 1000).toISOString().slice(0, 10);
        if (d.store.totalTurns(day) >= d.dailyCap) return send(res, 429, { error: "The agent's daily budget is used up. The chain pages still work." });
        const body = await readJson(req);
        const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
        if (!messages.length) return send(res, 400, { error: "no messages" });
        const chatId = typeof body.chatId === "string" && /^[\w-]{8,64}$/.test(body.chatId) ? body.chatId : randomUUID();
        let upstream: Response;
        try {
          upstream = await d.agent(messages, (body.env ?? {}) as WalletEnv, `web-${chatId}`);
        } catch (e) {
          return send(res, 503, { error: `Agent unavailable right now (${(e as Error).message}). Vault and market pages still work.` });
        }
        d.store.addTurn(ip, day);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
        const reader = upstream.body!.getReader();
        let text = "";
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
          for (const m of dec.decode(value, { stream: true }).matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)) {
            try { text += JSON.parse(`"${m[1]}"`); } catch { /* partial frame */ }
          }
        }
        res.end();
        const asked = String(messages[messages.length - 1]?.content ?? "").slice(0, 120);
        if (text) d.store.logDecision({ at: Date.now(), kind: "verdict", subject: asked, reason: text.slice(0, 4000), block: null });
        return;
      }

      if (req.method === "GET" && path === "/siwe/nonce") return send(res, 200, { nonce: newNonce(d.store) });
      if (req.method === "POST" && path === "/siwe/verify") {
        const b = await readJson(req);
        const address = await verifySiwe(d.store, String(b.message ?? ""), b.signature as Hex);
        if (!address) return send(res, 401, { error: "signature did not check out" });
        const token = d.store.newSession(address, SESSION_TTL_MS);
        return send(res, 200, { address }, { "set-cookie": sessionCookie(token) });
      }

      if (path === "/watch") {
        const me = signedIn(req);
        if (!me) return send(res, 401, { error: "sign in first" });
        if (req.method === "GET") return send(res, 200, d.store.watchesFor(me)[0] ?? null);
        if (req.method === "POST") {
          const b = await readJson(req);
          const maxPerBuyWei = BigInt(b.maxPerBuyWei ?? "0");
          if (maxPerBuyWei <= 0n || maxPerBuyWei > 1000n * 10n ** 18n) return send(res, 400, { error: "maxPerBuyWei must be between 0 and 1000 PROS" });
          d.store.upsertWatch({
            address: me, maxPerBuyWei, maxReserveBeforeWei: BigInt(b.maxReserveBeforeWei ?? "0"),
            curatorDeny: Array.isArray(b.curatorDeny) ? b.curatorDeny.filter((x: unknown) => typeof x === "string" && isAddress(x)) : [],
          });
          return send(res, 200, d.store.watchesFor(me)[0]);
        }
      }
      if (req.method === "GET" && path === "/alerts") return send(res, 200, { bot: d.telegramBot() });
      if (req.method === "POST" && path === "/telegram/link") {
        const bot = d.telegramBot();
        if (!bot) return send(res, 409, { error: "This copy of Prosperion has no Telegram bot, so it sends no alerts." });
        const me = signedIn(req);
        if (!me) return send(res, 401, { error: "sign in first" });
        if (!d.store.watchesFor(me).length) return send(res, 400, { error: "save a watch first" });
        return send(res, 200, { code: d.store.newLinkCode(me), bot });
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      console.error(`[api] ${(e as Error).stack}`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    }
  };
}
