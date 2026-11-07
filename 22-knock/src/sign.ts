// The hand-off. knock serves the plan on 127.0.0.1 to a page that talks to the browser wallet you already have
// (window.ethereum). The wallet signs; knock only reads. Right before each signature the page asks knock to build
// the whole payment again from the same sentence at the latest block, and what the wallet then gets is that fresh
// build, not the file: a plan file is just a note, anyone could have edited it. If anything changed (balance
// spent, name now points elsewhere, the signature window ran out), nothing goes to the wallet and the page says why.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { encodeFunctionData, formatUnits, getAddress, parseAbi, recoverTypedDataAddress, type Hex } from "viem";
import { ETHEREUM_RPC, RpcChain, type Chain } from "./chain.js";
import { buildPlan, receiveCalldata, type Plan } from "./plan.js";
import { explainRevert } from "./recipient.js";
import { renderSummary } from "./render.js";
import { PHAROS_CHAIN_ID, USDC } from "./registry.js";

/** What the payer hands to someone else's payee: the plan plus the signed authorization. */
export interface Handoff {
  kind: "knock-authorization";
  plan: Plan;
  signature: Hex;
}

export interface Verdict {
  ok: boolean;
  says: string;
  /** For a transfer: the freshly built tx the wallet should get. */
  tx?: Plan["tx"];
  /** The summary of the fresh build, so the page shows what is actually about to be signed. */
  summary?: string;
}

const AUTH_STATE = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const PHAROS_HEX_ID = "0x688";
type Message = { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex };
const messageOf = (plan: Plan) => (plan.byAuthorization?.typedData as { message: Message } | undefined)?.message;
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * The payee's side gets a file from the payer. Before showing it, we make sure the file agrees with itself and
 * with the signature: the signed message is what will move, so the summary has to be the signed message.
 */
export async function verifyHandoff(h: Handoff): Promise<{ ok: boolean; says: string }> {
  const auth = h.plan.byAuthorization;
  const m = messageOf(h.plan);
  if (!auth || !m) return { ok: false, says: "the file has no signed authorization in it" };
  const td = auth.typedData as { domain: { name: string; version: string; chainId: number; verifyingContract: Hex }; types: Record<string, { name: string; type: string }[]>; primaryType: string };
  if (td.domain.chainId !== PHAROS_CHAIN_ID || !same(td.domain.verifyingContract, USDC.address as string) || td.domain.name !== "USDC" || td.domain.version !== "2")
    return { ok: false, says: "the authorization is not for Pharos USDC" };
  if (!same(m.from, h.plan.from) || !same(m.to, h.plan.to) || !same(m.to, auth.payee) || m.value !== h.plan.raw || Number(m.validBefore) !== auth.validBefore || !same(m.nonce, auth.nonce))
    return { ok: false, says: "the signed message and the rest of the file disagree (amount, payer, payee or window); not trusting either" };
  let signer: Hex;
  try {
    const { EIP712Domain: _domainType, ...types } = td.types;
    signer = await recoverTypedDataAddress({
      domain: td.domain,
      types,
      primaryType: "ReceiveWithAuthorization",
      message: { ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) },
      signature: h.signature,
    });
  } catch (e) {
    return { ok: false, says: `the signature can't be read: ${(e as Error).message.split("\n")[0]}` };
  }
  if (!same(signer, m.from)) return { ok: false, says: `the signature was made by ${signer}, not by the payer ${m.from}` };
  return { ok: true, says: `signed by ${getAddress(m.from)}: ${formatUnits(BigInt(m.value), 6)} USDC to ${getAddress(m.to)}` };
}

export async function recheck(ph: Chain, l1: Chain, plan: Plan, who: string, chainId: string, mode: "transfer" | "signature" | "payee"): Promise<Verdict> {
  if (chainId.toLowerCase() !== PHAROS_HEX_ID) return { ok: false, says: `your wallet is on chain ${parseInt(chainId, 16)}; switch it to Pharos (1672) first` };
  const expected = mode === "payee" ? plan.byAuthorization?.payee : plan.from;
  if (!expected || !same(who, expected)) return { ok: false, says: `this was prepared for ${expected}; the wallet connected is ${who}. Switch accounts, nothing was signed` };

  if (mode !== "transfer") {
    const auth = plan.byAuthorization;
    if (!auth) return { ok: false, says: "this plan has no pay-by-signature part (only USDC has one)" };
    const left = auth.validBefore - Math.floor(Date.now() / 1000);
    if (left < 60) return { ok: false, says: `the signature window closed ${left < 0 ? `${-left} s ago` : "in under a minute"}; prepare the payment again` };
    const used = await ph.call({ to: USDC.address as Hex, data: encodeFunctionData({ abi: AUTH_STATE, functionName: "authorizationState", args: [plan.from, auth.nonce] }) });
    if (used.ok && BigInt(used.data) !== 0n) return { ok: false, says: "this authorization was already used or cancelled on chain" };
    if (mode === "payee") return { ok: true, says: `the authorization is unused and valid for another ${Math.floor(left / 60)} min` };
  }

  // The whole knock again, from the same words, against the latest block.
  const fresh = await buildPlan(ph, l1, plan.intent, plan.from);
  if (!fresh.plan) return { ok: false, says: `not any more: ${fresh.verdicts.find((v) => v.level === "BLOCK")?.says ?? "the checks no longer pass"}` };
  const f = fresh.plan;
  if (!same(f.to, plan.to)) return { ok: false, says: `the recipient changed since the plan was made: now ${f.to}` };
  if (mode === "transfer") {
    if (f.transferNeedsPros) return { ok: false, says: `the normal transfer can't go: ${f.transferNeedsPros}. Pay by signature instead` };
    if (!same(f.tx.to, plan.tx.to) || !same(f.tx.data, plan.tx.data) || f.tx.value !== plan.tx.value)
      return { ok: false, says: "the transaction in the plan file doesn't match what these words build now; the file was changed or is from another request. Run knock pay again" };
  } else {
    const m = messageOf(plan);
    if (!m || !same(m.from, f.from) || !same(m.to, f.to) || m.value !== f.raw)
      return { ok: false, says: "the signature request in the plan file doesn't match what these words build now; run knock pay again" };
  }
  const warns = f.verdicts.filter((v) => v.level === "WARN").length;
  return {
    ok: true,
    says: `checked again at block ${f.block}: still goes through${warns ? `, with ${warns} warning${warns > 1 ? "s" : ""} shown above` : ""}`,
    tx: f.tx,
    summary: renderSummary(fresh),
  };
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const c of req) s += c;
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, code: number, type: string, data: string) {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

function payeeSummary(h: Handoff): string {
  const m = messageOf(h.plan)!;
  return [
    `Receive ${formatUnits(BigInt(m.value), 6)} USDC`,
    `  from        ${getAddress(m.from)} (signed it)`,
    `  to          ${getAddress(m.to)} (you: only you can submit this)`,
    `  valid until ${new Date(Number(m.validBefore) * 1000).toISOString().replace(".000Z", "Z")}`,
    `  network     Pharos mainnet, chain 1672`,
    "",
    "Read from the signed message itself, not from the rest of the file. You pay the gas of the submit.",
  ].join("\n");
}

export async function serveSigning(file: string, port: number, ph: Chain = new RpcChain(), l1: Chain = new RpcChain(ETHEREUM_RPC)): Promise<void> {
  const loaded = JSON.parse(readFileSync(file, "utf8")) as Plan | Handoff;
  const handoff = (loaded as Handoff).kind === "knock-authorization" ? (loaded as Handoff) : undefined;
  const plan = handoff ? handoff.plan : (loaded as Plan);
  if (handoff) {
    const v = await verifyHandoff(handoff);
    if (!v.ok) throw new Error(`not serving ${file}: ${v.says}`);
    console.log(v.says);
  }
  const summary = handoff ? payeeSummary(handoff) : renderSummary({ plan, verdicts: plan.verdicts, intent: plan.intent });
  // What we handed to the wallet, by kind, to compare with what got mined.
  const handed: Record<string, { to: Hex; data: Hex; value: bigint }> = {};

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") return send(res, 200, "text/html; charset=utf-8", PAGE);
      if (req.method === "GET" && req.url === "/plan") return send(res, 200, "application/json", json({ plan, summary, payeeMode: !!handoff }));
      if (req.method === "POST" && req.url === "/recheck") {
        const b = await body(req);
        const v = await recheck(ph, l1, plan, String(b.address ?? ""), String(b.chainId ?? ""), (b.mode as "transfer" | "signature" | "payee") ?? "transfer");
        if (v.ok && v.tx) handed.transfer = { to: v.tx.to, data: v.tx.data, value: BigInt(v.tx.value) };
        console.log(`recheck (${b.mode}): ${v.ok ? "OK" : "BLOCKED"} - ${v.says}`);
        return send(res, 200, "application/json", json(v));
      }
      if (req.method === "POST" && req.url === "/claim") {
        // Signature in, the payee's unsigned receiveWithAuthorization out, simulated from the payee first.
        const b = await body(req);
        const sig = (handoff?.signature ?? b.signature) as Hex;
        const auth = plan.byAuthorization!;
        if (!handoff) {
          const v = await verifyHandoff({ kind: "knock-authorization", plan, signature: sig });
          if (!v.ok) return send(res, 200, "application/json", json({ ok: false, says: v.says }));
        }
        const data = receiveCalldata(auth, sig);
        const tx = { from: getAddress(auth.payee), to: getAddress(USDC.address as Hex), data };
        const est = await ph.estimateGas(tx);
        if (!est.ok) return send(res, 200, "application/json", json({ ok: false, says: `the payee's call would fail: ${explainRevert(est.revert, est.message)}` }));
        handed.claim = { to: tx.to, data, value: 0n };
        const gas = `0x${((est.gas! * 12n + 9n) / 10n).toString(16)}`;
        console.log(`claim prepared for ${auth.payee}, gas ${est.gas}`);
        return send(res, 200, "application/json", json({ ok: true, says: `simulated from the payee: goes through (gas ${est.gas})`, tx: { ...tx, gas, value: "0x0" } }));
      }
      if (req.method === "POST" && req.url === "/receipt") {
        const b = await body(req);
        const r = await ph.receipt(String(b.hash));
        if (!r) return send(res, 200, "application/json", "null");
        const mined = await ph.txInput(String(b.hash));
        const want = handed[String(b.kind)];
        const match = !!mined && !!want && same(mined.to ?? undefined, want.to) && same(mined.input, want.data) && mined.value === want.value;
        console.log(`tx ${b.hash}: ${r.status} in block ${r.blockNumber}, gas used ${r.gasUsed}; mined to/value/input ${match ? "match" : "DO NOT match"} what knock handed to the wallet`);
        return send(res, 200, "application/json", json({ ...r, same: match }));
      }
      send(res, 404, "text/plain", "not here");
    } catch (e) {
      send(res, 500, "application/json", json({ ok: false, says: (e as Error).message }));
    }
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  console.log(`knock signing page: http://127.0.0.1:${port}/  (${handoff ? "payee side of a signed authorization" : "your payment"}; knock holds no key, your wallet signs)`);
  console.log("Ctrl+C to stop.");
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>knock: sign the payment</title>
<style>
:root{--ink:#1d1d1f;--paper:#fbfaf7;--line:#ddd;--ok:#2e7d4f;--bad:#b3261e}
body{font:15px/1.45 system-ui,sans-serif;max-width:880px;margin:28px auto;padding:0 16px;color:var(--ink);background:var(--paper)}
h1{font-size:22px;margin:0 0 6px} pre{white-space:pre-wrap;background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 14px;font:13px/1.5 ui-monospace,monospace}
.row{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0} button{font:inherit;padding:7px 15px;border-radius:6px;border:1px solid #333;background:var(--ink);color:#fff;cursor:pointer}
button:disabled{background:#999;border-color:#999;cursor:default} .msg{margin:6px 0;font-size:14px} .ok{color:var(--ok)} .bad{color:var(--bad)}
</style></head><body>
<h1>knock: the payment, for your wallet to sign</h1>
<pre id="summary">loading...</pre>
<div class="row"><button id="connect">Connect wallet</button><span id="who" class="msg"></span></div>
<div class="row" id="buttons"></div>
<div id="log"></div>
<script>
const $=s=>document.querySelector(s); let plan, payeeMode, me, chainId;
const post=(u,b)=>fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(r=>r.json());
function say(t,cls){const d=document.createElement("div");d.className="msg "+(cls||"");d.textContent=t;$("#log").appendChild(d);return d}
function btn(label,fn){const b=document.createElement("button");b.textContent=label;b.disabled=true;b.onclick=()=>fn(b);$("#buttons").appendChild(b);return b}
let buttons=[];
async function init(){
  const r=await fetch("/plan").then(r=>r.json()); plan=r.plan; payeeMode=r.payeeMode; $("#summary").textContent=r.summary;
  if(payeeMode) buttons.push(btn("Submit the signed payment",b=>claimAndSend(b,null,"payee")));
  else { buttons.push(btn("Send transfer",sendTransfer)); if(plan.byAuthorization) buttons.push(btn("Pay by signature",paySigned)); }
}
async function look(){ [me]=await ethereum.request({method:"eth_accounts"}); chainId=await ethereum.request({method:"eth_chainId"}); $("#who").textContent="connected "+me+" on chain "+parseInt(chainId,16); }
$("#connect").onclick=async()=>{
  if(!window.ethereum){$("#who").textContent="no browser wallet found";return}
  await ethereum.request({method:"eth_requestAccounts"});
  if(await ethereum.request({method:"eth_chainId"})!=="0x688"){try{await ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x688"}]})}catch(e){}}
  await look(); buttons.forEach(b=>b.disabled=false);
  if(ethereum.on){ethereum.on("chainChanged",look);ethereum.on("accountsChanged",look);}
};
// Ask the wallet again right before every signature: the account or chain may have changed since Connect.
async function gate(mode){await look();const m=say("checking against the live chain...");const v=await post("/recheck",{address:me,chainId,mode});m.textContent=v.says;m.className="msg "+(v.ok?"ok":"bad");if(v.summary)$("#summary").textContent=v.summary;return v.ok?v:null}
async function watch(hash,kind){
  const m=say("sent "+hash+", waiting for the block...");
  let r=null; while(!r){await new Promise(z=>setTimeout(z,1500)); r=await post("/receipt",{hash,kind});}
  if(r.status!=="success"){m.textContent="reverted on chain: "+hash;m.className="msg bad";return}
  m.className="msg ok"; m.innerHTML='done in block '+r.blockNumber+': <a target=_blank href="https://www.pharosscan.xyz/tx/'+hash+'">'+hash+'</a>. Mined tx '+(r.same?"matches":"does NOT match")+" what knock handed to your wallet.";
}
async function sendTransfer(b){
  b.disabled=true; const v=await gate("transfer"); if(!v){b.disabled=false;return}
  const t=v.tx; let hash;
  try{hash=await ethereum.request({method:"eth_sendTransaction",params:[{from:me,to:t.to,data:t.data,value:t.value,gas:t.gas,chainId:"0x688"}]})}
  catch(e){say("not signed: "+(e.message||e),"bad");b.disabled=false;return}
  watch(hash,"transfer");
}
async function paySigned(b){
  b.disabled=true; if(!await gate("signature")){b.disabled=false;return}
  let sig; try{sig=await ethereum.request({method:"eth_signTypedData_v4",params:[me,JSON.stringify(plan.byAuthorization.typedData)]})}
  catch(e){say("not signed: "+(e.message||e),"bad");b.disabled=false;return}
  say("signed the authorization (no transaction yet)","ok");
  if(plan.byAuthorization.payee.toLowerCase()===me.toLowerCase()) return claimAndSend(b,sig,"signature");
  const file=new Blob([JSON.stringify({kind:"knock-authorization",plan,signature:sig},null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(file);a.download="knock-authorization.json";a.textContent="download knock-authorization.json";
  say("Hand this file to the payee; they open it with: knock sign knock-authorization.json").appendChild(document.createElement("br"));$("#log").appendChild(a);
}
async function claimAndSend(b,sig,mode){
  b.disabled=true; if(mode==="payee"&&!await gate("payee")){b.disabled=false;return}
  await look(); if(chainId!=="0x688"){say("your wallet is not on Pharos (1672) any more; nothing sent","bad");b.disabled=false;return}
  const c=await post("/claim",{signature:sig}); say(c.says,c.ok?"ok":"bad"); if(!c.ok){b.disabled=false;return}
  let hash; try{hash=await ethereum.request({method:"eth_sendTransaction",params:[{from:me,to:c.tx.to,data:c.tx.data,value:"0x0",gas:c.tx.gas,chainId:"0x688"}]})}
  catch(e){say("not sent: "+(e.message||e),"bad");b.disabled=false;return}
  watch(hash,"claim");
}
init();
</script></body></html>`;
