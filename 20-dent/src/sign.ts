// The hand-off. dent serves the plan on 127.0.0.1 to a page that talks to the browser wallet the user already
// has (window.ethereum). The wallet signs; dent only reads. Before every signature the page asks dent to check
// the step again against the live chain, and before the first one dent runs the whole comparison again: if the
// move stopped paying since the plan was written, the button stays disabled and the page says why.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { Chain } from "./chain.js";
import { look } from "./look.js";
import type { Plan } from "./plan.js";
import { explainRevert } from "./reads.js";
import { LANE_DECIMALS } from "./venues.js";
import { formatUnits } from "viem";

export interface Verdict {
  ok: boolean;
  says: string;
  detail?: string;
}

/** Is step `i` still a good idea, for this address, right now? */
export async function recheck(chain: Chain, plan: Plan, i: number, address: string): Promise<Verdict> {
  if (address.toLowerCase() !== plan.wallet.toLowerCase())
    return { ok: false, says: `this plan was made for ${plan.wallet}; the wallet connected is ${address}` };
  const step = plan.steps[i];
  if (!step) return { ok: false, says: `there is no step ${i + 1}` };

  if (i === 0) {
    const fresh = await look(chain, {
      wallet: plan.wallet,
      lane: plan.lane,
      from: plan.from,
      amount: formatUnits(BigInt(plan.amount), LANE_DECIMALS[plan.lane]),
      holdDays: plan.holdDays,
      minGain: plan.minGain,
      keepPros: 0,
    });
    const d = fresh.decision;
    if (d.action !== "MOVE" || d.to !== plan.to)
      return { ok: false, says: `the move no longer pays: ${d.action === "MOVE" ? `now the better place is ${d.to}` : d.reason}`, detail: `re-checked at block ${fresh.block}` };
    const o = d.options.find((x) => x.id === plan.to)!;
    const sim = await chain.call({ from: address, to: step.to, data: step.data, value: BigInt(step.value) }, "latest");
    if (!sim.ok) return { ok: false, says: `step 1 would revert now: ${explainRevert(sim.revert, sim.message)}` };
    return { ok: true, says: `still worth it at block ${fresh.block}: net ${o.net?.toFixed(6)} ${plan.lane} over ${plan.holdDays} days, break-even ${o.breakEvenDays} days` };
  }

  const sim = await chain.call({ from: address, to: step.to, data: step.data, value: BigInt(step.value) }, "latest");
  if (!sim.ok) {
    const why = explainRevert(sim.revert, sim.message);
    if (step.phase === 2) return { ok: false, says: `not claimable yet (${why}); the unbonding wait is ${plan.waitSeconds / 3600} h` };
    return { ok: false, says: `this step would revert now: ${why}` };
  }
  return { ok: true, says: "simulated against the latest block: goes through" };
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

export async function serveSigning(chain: Chain, planPath: string, port: number): Promise<void> {
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") return send(res, 200, "text/html; charset=utf-8", PAGE);
      if (req.method === "GET" && req.url === "/plan") return send(res, 200, "application/json", JSON.stringify(plan));
      if (req.method === "POST" && req.url === "/recheck") {
        const b = await body(req);
        const v = await recheck(chain, plan, Number(b.index), String(b.address ?? ""));
        console.log(`recheck step ${Number(b.index) + 1}: ${v.ok ? "OK" : "BLOCKED"} - ${v.says}`);
        return send(res, 200, "application/json", JSON.stringify(v));
      }
      if (req.method === "POST" && req.url === "/receipt") {
        const b = await body(req);
        const r = await chain.receipt(String(b.hash));
        if (r) console.log(`tx ${b.hash}: ${r.status} in block ${r.blockNumber}, gas used ${r.gasUsed}`);
        return send(res, 200, "application/json", JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      }
      send(res, 404, "text/plain", "not here");
    } catch (e) {
      send(res, 500, "application/json", JSON.stringify({ ok: false, says: (e as Error).message }));
    }
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  console.log(`dent signing page: http://127.0.0.1:${port}/  (plan ${planPath}, ${plan.steps.length} steps; dent holds no key, your wallet signs)`);
  console.log("Ctrl+C to stop.");
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>dent: sign the move</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1d1d1f;background:#fbfaf7}
h1{font-size:22px;margin:0 0 4px} .sub{color:#666;margin-bottom:18px}
.step{border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:10px 0;background:#fff}
.step.done{border-color:#2e8b57;background:#f2fbf5} .step.blocked{border-color:#c0392b;background:#fdf3f2}
code{font:12px ui-monospace,monospace;word-break:break-all;color:#444}
button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #333;background:#1d1d1f;color:#fff;cursor:pointer}
button:disabled{background:#999;border-color:#999;cursor:default} .msg{margin-top:6px;font-size:14px}
.ok{color:#2e8b57} .bad{color:#c0392b}
</style></head><body>
<h1>dent: the move, for your wallet to sign</h1>
<div class="sub" id="sub">loading plan...</div>
<button id="connect">Connect wallet</button> <span id="who"></span>
<div id="steps"></div>
<script>
const $=s=>document.querySelector(s); let plan, me, nextIdx=0;
const post=(u,b)=>fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(r=>r.json());
async function init(){
  plan=await fetch("/plan").then(r=>r.json());
  $("#sub").textContent=plan.lane+" lane: "+plan.from+" -> "+plan.to+", hold "+plan.holdDays+" days. Plan made "+plan.createdAt+" for "+plan.wallet+".";
  $("#steps").innerHTML=plan.steps.map((s,i)=>'<div class="step" id="s'+i+'"><b>'+(i+1)+'. '+s.says+'</b> <small>(phase '+s.phase+', gas '+(s.gas||'?')+' '+s.gasHow+')</small><br><code>to '+s.to+' value '+s.value+'<br>data '+s.data+'</code><br><button disabled id="b'+i+'">Check again, then sign</button><div class="msg" id="m'+i+'"></div></div>').join("");
  plan.steps.forEach((s,i)=>$("#b"+i).onclick=()=>go(i));
}
$("#connect").onclick=async()=>{
  if(!window.ethereum){$("#who").textContent="no browser wallet found";return}
  [me]=await ethereum.request({method:"eth_requestAccounts"});
  const cid=await ethereum.request({method:"eth_chainId"});
  if(cid!=="0x688"){try{await ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x688"}]})}catch(e){$("#who").textContent="switch your wallet to Pharos (chain 1672) first";return}}
  $("#who").textContent="connected "+me; $("#b"+nextIdx).disabled=false;
};
async function go(i){
  const b=$("#b"+i), m=$("#m"+i); b.disabled=true; m.className="msg"; m.textContent="checking against the live chain...";
  const v=await post("/recheck",{index:i,address:me});
  m.textContent=v.says; m.className="msg "+(v.ok?"ok":"bad");
  if(!v.ok){$("#s"+i).classList.add("blocked"); b.disabled=false; b.textContent="Check again"; return}
  const s=plan.steps[i];
  let hash; try{ hash=await ethereum.request({method:"eth_sendTransaction",params:[{from:me,to:s.to,data:s.data,value:"0x"+BigInt(s.value).toString(16)}]}) }
  catch(e){ m.textContent="not signed: "+(e.message||e); m.className="msg bad"; b.disabled=false; return }
  m.textContent="sent "+hash+", waiting for the block...";
  let r=null; while(!r){ await new Promise(z=>setTimeout(z,1500)); r=await post("/receipt",{hash}); }
  if(r.status!=="success"){ m.textContent="reverted on chain: "+hash; m.className="msg bad"; return }
  $("#s"+i).classList.remove("blocked"); $("#s"+i).classList.add("done");
  m.innerHTML='done in block '+r.blockNumber+': <a target=_blank href="https://www.pharosscan.xyz/tx/'+hash+'">'+hash+'</a>'; m.className="msg ok";
  nextIdx=i+1; if($("#b"+nextIdx)) $("#b"+nextIdx).disabled=false;
}
init();
</script></body></html>`;
