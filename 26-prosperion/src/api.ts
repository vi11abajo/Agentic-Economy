// Prosperion's HTTP API, behind nginx at /api/. Reads are open; watches and the chat need a signed-in address.
// Chat limits belong to a person, not to an IP or a wallet: see store.linkIdentity. The important one is /api/req/:id: a push link opens the sign page, the page asks here, and we
// re-check the market at the current block before handing back a transaction. If anything changed since the alert
// (someone bought first, the market code was upgraded, it left the curve), the answer is a refusal in words and no tx.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { encodeFunctionData, getAddress, isAddress, parseAbi, parseEther, type Address, type Hex } from "viem";
import { SESSION_COOKIE, SESSION_TTL_MS, endedSessionCookie, newNonce, sessionCookie, verifySiwe } from "./auth.js";
import type { ChatMessage, WalletEnv } from "./agent.js";
import type { MarketCheck } from "./market.js";
import type { Store } from "./store.js";
import { prepareBuy, refusalFor } from "./prepare.js";
import { launchRefresher } from "./freshLaunches.js";

export const GATE_ABI = parseAbi([
  "function buy(address market, uint256 minOut, uint256 deadline) payable returns (uint256)",
  "function setLimits((uint128 maxPerBuy, uint128 maxPerDay, uint128 maxReserveBefore, address acceptedMarketImpl) l)",
  "function limitsOf(address) view returns (uint128 maxPerBuy, uint128 maxPerDay, uint128 maxReserveBefore, address acceptedMarketImpl)",
  "function spentOn(address user, uint256 day) view returns (uint256)",
  "function marketBeacon() view returns (address)",
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
  /** PROS this wallet has put through the gate in the current UTC day, as the gate counts it */
  spentToday: (owner: Address) => Promise<bigint>;
  /** the Prosper market code the beacon points at right now */
  marketImpl: () => Promise<Address>;
  readVault: (vault: Address, block?: bigint) => Promise<unknown>;
  listVaults: () => Promise<unknown[]>;
  explainNavMove: (vault: Address, from: bigint, to: bigint) => Promise<unknown>;
  agent: (messages: ChatMessage[], env: WalletEnv, sessionKey: string, signal?: AbortSignal) => Promise<Response>;
  /** The bot's username, or null when whoever runs this copy has not set up their own bot (then no alerts go out). */
  telegramBot: () => string | null;
  /** questions one person (their linked wallets and IPs) may ask per minute */
  perMinute: number;
  /** questions one person may ask per UTC day */
  userDaily: number;
  /** questions everyone together may ask per UTC day: the model bill's ceiling */
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

export { refusalFor };

const NO_IMPL = "0x0000000000000000000000000000000000000000" as Address;
const prosNumber = /^\d+(\.\d{1,18})?$/;
const bigger = (a: bigint, b: bigint) => (a > b ? a : b);

/** What a person typed into "Your buy limits", as gate limits, or the reason it cannot work. */
export function limitsFromForm(b: Record<string, unknown>, implNow: Address): GateLimits | string {
  if (b.stop === true) return { maxPerBuy: 0n, maxPerDay: 0n, maxReserveBefore: 0n, acceptedMarketImpl: NO_IMPL };
  for (const k of ["perBuyPros", "perDayPros", "inCurvePros"]) {
    if (typeof b[k] !== "string" || !prosNumber.test(b[k] as string)) return `${k} must be a number like 0.5`;
  }
  const maxPerBuy = parseEther(b.perBuyPros as string), maxPerDay = parseEther(b.perDayPros as string);
  const maxReserveBefore = parseEther(b.inCurvePros as string);
  if (maxPerBuy === 0n) return "PROS per buy must be above 0. To switch buys off, use Stop all buys.";
  if (maxPerBuy > parseEther("1000")) return "PROS per buy is capped at 1000 here.";
  if (maxPerDay < maxPerBuy) return "PROS a day has to be at least PROS per buy, or no buy could ever pass.";
  if (maxPerDay > parseEther("10000")) return "PROS a day is capped at 10000 here.";
  if (maxReserveBefore > parseEther("1000000")) return "PROS already in the curve is capped at 1000000 here.";
  return { maxPerBuy, maxPerDay, maxReserveBefore, acceptedMarketImpl: implNow };
}

export function createApi(d: ApiDeps) {
  const freshLaunches = launchRefresher(d.store, d.check, d.now);
  // "Prepare first buy" only writes a row, but rows are still rows: a few a minute per wallet is plenty for a person.
  const prepares = new Map<string, number[]>();
  const tooManyPrepares = (me: Address) => {
    const t = d.now(), key = me.toLowerCase();
    const recent = (prepares.get(key) ?? []).filter((x) => x > t - 60);
    if (recent.length >= 10) return true;
    prepares.set(key, [...recent, t]);
    return false;
  };
  // A person's turn that is still streaming. Keyed by the group's first wallet, so the same person asking from
  // the laptop while the phone's question runs gets told to wait instead of doubling the load.
  const inFlight = new Set<string>();
  const personKey = (me: Address) => d.store.userOf(me).wallets.map((w) => w.toLowerCase()).sort()[0] ?? me.toLowerCase();
  const startOfDay = () => { const t = d.now(); return t - (t % 86_400); };
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
    // The gate also counts the day: a buy that fits per buy but not in what is left of today would only revert.
    const spent = have ? await d.spentToday(owner) : 0n;
    const fits = have && have.maxPerBuy >= amount && have.maxReserveBefore >= maxReserve && spent + amount <= have.maxPerDay &&
      have.acceptedMarketImpl.toLowerCase() === want.acceptedMarketImpl.toLowerCase();
    // Raise what this buy needs and nothing else: limits someone set higher on purpose stay where they are.
    if (have) {
      want.maxPerBuy = bigger(have.maxPerBuy, amount);
      want.maxPerDay = bigger(have.maxPerDay, bigger(want.maxPerDay, spent + amount));
      want.maxReserveBefore = bigger(have.maxReserveBefore, maxReserve);
    }
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
      if (req.method === "GET" && path === "/launches") return send(res, 200, await freshLaunches(30));
      if (req.method === "GET" && path === "/decisions") return send(res, 200, d.store.decisions(50));

      if (req.method === "GET" && path === "/me") {
        const me = signedIn(req);
        if (!me) return send(res, 200, { address: null });
        d.store.linkIdentity(me, ip);
        return send(res, 200, { address: me, used: d.store.userTurnsSince(me, startOfDay()), dailyLimit: d.userDaily });
      }

      if (req.method === "POST" && path === "/chat") {
        const me = signedIn(req);
        if (!me) return send(res, 401, { error: "Connect your wallet to work with Prosperion." });
        d.store.linkIdentity(me, ip);
        const now = d.now();
        if (d.store.userTurnsSince(me, now - 60) >= d.perMinute)
          return send(res, 429, { error: "That is enough questions for this minute. Give it a moment." });
        if (d.store.userTurnsSince(me, startOfDay()) >= d.userDaily)
          return send(res, 429, { error: `You have asked ${d.userDaily} questions today, the daily limit. It resets at 00:00 UTC.` });
        if (d.store.allTurnsSince(startOfDay()) >= d.dailyCap)
          return send(res, 429, { error: "The agent's daily budget is used up. The vault and launch pages still work." });
        const who = personKey(me);
        if (inFlight.has(who)) return send(res, 429, { error: "One question at a time: the agent is still answering your last one." });
        const body = await readJson(req);
        const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
        if (!messages.length) return send(res, 400, { error: "no messages" });
        const chatId = typeof body.chatId === "string" && /^[\w-]{8,64}$/.test(body.chatId) ? body.chatId : randomUUID();
        // The wallet the agent hears about is the one that signed in, whatever the page claims.
        const env = { ...((body.env ?? {}) as WalletEnv), address: me };
        inFlight.add(who);
        const turn = d.store.addChatTurn(now, ip, me);
        try {
          let upstream: Response;
          try {
            upstream = await d.agent(messages, env, `web-${me.toLowerCase()}-${chatId}`);
          } catch (e) {
            d.store.dropChatTurn(turn);
            return send(res, 503, { error: `Agent unavailable right now (${(e as Error).message}). Vault and market pages still work.` });
          }
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
          res.flushHeaders(); // the page knows the turn was accepted before the agent says its first word
          const reader = upstream.body!.getReader();
          let text = "";
          const dec = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            res.write(value);
            // Hermes writes "content": "..." with a space after the colon.
            for (const m of dec.decode(value, { stream: true }).matchAll(/"content":\s*"((?:[^"\\]|\\.)*)"/g)) {
              try { text += JSON.parse(`"${m[1]}"`); } catch { /* partial frame */ }
            }
          }
          res.end();
          const asked = String(messages[messages.length - 1]?.content ?? "").slice(0, 120);
          if (text) d.store.logDecision({ at: Date.now(), kind: "verdict", subject: asked, reason: text.slice(0, 4000), block: null });
          return;
        } finally {
          inFlight.delete(who);
        }
      }

      if (req.method === "GET" && path === "/siwe/nonce") return send(res, 200, { nonce: newNonce(d.store) });
      if (req.method === "POST" && path === "/siwe/verify") {
        const b = await readJson(req);
        const address = await verifySiwe(d.store, String(b.message ?? ""), b.signature as Hex);
        if (!address) return send(res, 401, { error: "signature did not check out" });
        d.store.linkIdentity(address, ip);
        const token = d.store.newSession(address, SESSION_TTL_MS);
        return send(res, 200, { address }, { "set-cookie": sessionCookie(token) });
      }
      // The wallet menu's Sign out. The token dies on our side too, not just in this browser's cookie jar.
      if (req.method === "POST" && path === "/signout") {
        const t = cookie(req, SESSION_COOKIE);
        if (t) d.store.endSession(t);
        return send(res, 200, { address: null }, { "set-cookie": endedSessionCookie });
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
      // The Launches page's "Prepare first buy": always for the signed-in wallet, whatever the body says.
      if (req.method === "POST" && path === "/prepare") {
        const me = signedIn(req);
        if (!me) return send(res, 401, { error: "Connect your wallet first: the buy is prepared for that wallet." });
        const b = await readJson(req);
        if (typeof b.market !== "string" || !isAddress(b.market)) return send(res, 400, { error: "market must be an address" });
        if (typeof b.amountPros !== "string" || !/^\d+(\.\d{1,18})?$/.test(b.amountPros)) return send(res, 400, { error: "amountPros must be a number like 0.5" });
        if (tooManyPrepares(me)) return send(res, 429, { error: "Ten buys prepared this minute. Wait a moment." });
        const r = await prepareBuy(d.store, d.check, { market: getAddress(b.market), owner: me, amountWei: parseEther(b.amountPros), source: "page" });
        return r.ok ? send(res, 200, { url: r.url, check: r.check }) : send(res, 409, { error: r.refusal, check: r.check });
      }
      // "Your buy limits" on the Launches page. We only read the gate and encode a setLimits; the wallet signs it.
      if (path === "/limits") {
        const me = signedIn(req);
        if (!me) return send(res, 401, { error: "Connect your wallet to see the limits the gate holds for it." });
        if (!d.gate) return send(res, 409, { error: "The Prosperion gate is not deployed on this copy." });
        const implNow = await d.marketImpl();
        if (req.method === "GET") {
          const [limits, spentToday] = await Promise.all([d.readLimits(me), d.spentToday(me)]);
          return send(res, 200, {
            gate: d.gate, address: me, limits, spentToday, implNow, dayEndsAt: startOfDay() + 86_400,
            implAccepted: !!limits && limits.acceptedMarketImpl.toLowerCase() === implNow.toLowerCase(),
          });
        }
        if (req.method === "POST") {
          const l = limitsFromForm(await readJson(req), implNow);
          if (typeof l === "string") return send(res, 400, { error: l });
          return send(res, 200, {
            limits: l,
            tx: { to: d.gate, value: "0", data: encodeFunctionData({ abi: GATE_ABI, functionName: "setLimits", args: [l] }) },
          });
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
