// The hand-off. knock serves the plan on 127.0.0.1 to a page that talks to the browser wallet you already have
// (window.ethereum). The wallet signs; knock only reads. Right before each signature the page asks knock to build
// the whole payment again from the same sentence at the latest block: if anything changed (balance spent, name
// now points elsewhere, the signature window ran out), the button stays disabled and the page says why.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { ETHEREUM_RPC, RpcChain, type Chain } from "./chain.js";
import { buildPlan, receiveCalldata, type Plan } from "./plan.js";
import { explainRevert } from "./recipient.js";
import { renderSummary } from "./render.js";
import { USDC } from "./registry.js";

/** What the payer hands to someone else's payee: the plan plus the signed authorization. */
export interface Handoff {
  kind: "knock-authorization";
  plan: Plan;
  signature: Hex;
}

export interface Verdict {
  ok: boolean;
  says: string;
}

const AUTH_STATE = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const PHAROS_HEX_ID = "0x688";

export async function recheck(ph: Chain, l1: Chain, plan: Plan, who: string, chainId: string, mode: "transfer" | "signature" | "payee"): Promise<Verdict> {
  if (chainId.toLowerCase() !== PHAROS_HEX_ID) return { ok: false, says: `your wallet is on chain ${parseInt(chainId, 16)}; switch it to Pharos (1672) first` };
  const expected = mode === "payee" ? plan.byAuthorization?.payee : plan.from;
  if (!expected || who.toLowerCase() !== expected.toLowerCase())
    return { ok: false, says: `this was prepared for ${expected}; the wallet connected is ${who}. Switch accounts, nothing was signed` };

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
  if (fresh.plan.to.toLowerCase() !== plan.to.toLowerCase()) return { ok: false, says: `the recipient changed since the plan was made: now ${fresh.plan.to}` };
  const warns = fresh.plan.verdicts.filter((v) => v.level === "WARN").length;
  return { ok: true, says: `checked again at block ${fresh.plan.block}: still goes through${warns ? `, with ${warns} warning${warns > 1 ? "s" : ""} shown above` : ""}` };
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

export async function serveSigning(file: string, port: number, ph: Chain = new RpcChain(), l1: Chain = new RpcChain(ETHEREUM_RPC)): Promise<void> {
  const loaded = JSON.parse(readFileSync(file, "utf8")) as Plan | Handoff;
  const handoff = (loaded as Handoff).kind === "knock-authorization" ? (loaded as Handoff) : undefined;
  const plan = handoff ? handoff.plan : (loaded as Plan);
  const summary = renderSummary({ plan, verdicts: plan.verdicts, intent: plan.intent });
  const prepared: Record<string, Hex> = { transfer: plan.tx.data };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") return send(res, 200, "text/html; charset=utf-8", PAGE);
      if (req.method === "GET" && req.url === "/plan") return send(res, 200, "application/json", json({ plan, summary, payeeMode: !!handoff }));
      if (req.method === "POST" && req.url === "/recheck") {
        const b = await body(req);
        const v = await recheck(ph, l1, plan, String(b.address ?? ""), String(b.chainId ?? ""), (b.mode as "transfer" | "signature" | "payee") ?? "transfer");
        console.log(`recheck (${b.mode}): ${v.ok ? "OK" : "BLOCKED"} - ${v.says}`);
        return send(res, 200, "application/json", json(v));
      }
      if (req.method === "POST" && req.url === "/claim") {
        // Signature in, the payee's unsigned receiveWithAuthorization out, simulated from the payee first.
        const b = await body(req);
        const sig = (handoff?.signature ?? b.signature) as Hex;
        const auth = plan.byAuthorization!;
        const data = receiveCalldata(auth, sig);
        const tx = { from: getAddress(auth.payee), to: USDC.address as Hex, data };
        const est = await ph.estimateGas(tx);
        if (!est.ok) return send(res, 200, "application/json", json({ ok: false, says: `the payee's call would fail: ${explainRevert(est.revert, est.message)}` }));
        prepared.claim = data;
        const gas = `0x${((est.gas! * 12n + 9n) / 10n).toString(16)}`;
        console.log(`claim prepared for ${auth.payee}, gas ${est.gas}`);
        return send(res, 200, "application/json", json({ ok: true, says: `simulated from the payee: goes through (gas ${est.gas})`, tx: { ...tx, gas, value: "0x0" } }));
      }
      if (req.method === "POST" && req.url === "/receipt") {
        const b = await body(req);
        const r = await ph.receipt(String(b.hash));
        if (!r) return send(res, 200, "application/json", "null");
        const mined = await ph.txInput(String(b.hash));
        const want = prepared[String(b.kind)];
        const same = !!mined && !!want && mined.input.toLowerCase() === want.toLowerCase();
        console.log(`tx ${b.hash}: ${r.status} in block ${r.blockNumber}, gas used ${r.gasUsed}; mined input ${same ? "matches" : "DOES NOT match"} what knock prepared`);
        return send(res, 200, "application/json", json({ ...r, same }));
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
$("#connect").onclick=async()=>{
  if(!window.ethereum){$("#who").textContent="no browser wallet found";return}
  [me]=await ethereum.request({method:"eth_requestAccounts"});
  chainId=await ethereum.request({method:"eth_chainId"});
  if(chainId!=="0x688"){try{await ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x688"}]});chainId="0x688"}catch(e){}}
  $("#who").textContent="connected "+me+" on chain "+parseInt(chainId,16); buttons.forEach(b=>b.disabled=false);
};
async function gate(mode){const m=say("checking against the live chain...");const v=await post("/recheck",{address:me,chainId,mode});m.textContent=v.says;m.className="msg "+(v.ok?"ok":"bad");return v.ok}
async function watch(hash,kind){
  const m=say("sent "+hash+", waiting for the block...");
  let r=null; while(!r){await new Promise(z=>setTimeout(z,1500)); r=await post("/receipt",{hash,kind});}
  if(r.status!=="success"){m.textContent="reverted on chain: "+hash;m.className="msg bad";return}
  m.className="msg ok"; m.innerHTML='done in block '+r.blockNumber+': <a target=_blank href="https://www.pharosscan.xyz/tx/'+hash+'">'+hash+'</a>. Mined input '+(r.same?"matches":"does NOT match")+" what knock prepared.";
}
async function sendTransfer(b){
  b.disabled=true; if(!await gate("transfer")){b.disabled=false;return}
  const t=plan.tx; let hash;
  try{hash=await ethereum.request({method:"eth_sendTransaction",params:[{from:me,to:t.to,data:t.data,value:t.value,gas:t.gas}]})}
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
  const c=await post("/claim",{signature:sig}); say(c.says,c.ok?"ok":"bad"); if(!c.ok){b.disabled=false;return}
  let hash; try{hash=await ethereum.request({method:"eth_sendTransaction",params:[{from:me,to:c.tx.to,data:c.tx.data,value:"0x0",gas:c.tx.gas}]})}
  catch(e){say("not sent: "+(e.message||e),"bad");b.disabled=false;return}
  watch(hash,"claim");
}
init();
</script></body></html>`;
