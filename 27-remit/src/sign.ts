// The hand-off to a human. remit holds no key: it serves the plan on 127.0.0.1 to a page that talks to the browser
// wallet you already have (window.ethereum), and your wallet signs. Right before the wallet is asked, remit runs the
// whole thing again from the invoice file for the account that is actually connected: a plan file is just a note
// on disk, and balances, the payee's history or the file itself may have changed since it was written.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, isAddress, type Hex } from "viem";
import { pharos, checkPaid } from "./chain.js";
import { planFromFile } from "./pipeline.js";
import { formatPaymentSummary } from "./tx.js";
import type { PaymentPlan } from "./types.js";

const PHAROS_HEX = "0x688";
const sameTx = (a: PaymentPlan["tx"], b: PaymentPlan["tx"]) =>
  a.to.toLowerCase() === b.to.toLowerCase() && BigInt(a.value) === BigInt(b.value) && a.data.toLowerCase() === b.data.toLowerCase();

export const logFor = (planFile: string) => `${resolve(planFile)}.sign.log`;

function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((ok) => {
    let s = "";
    req.on("data", (c) => (s += c).length > 10_000 && req.destroy());
    req.on("end", () => {
      try {
        ok(JSON.parse(s || "{}"));
      } catch {
        ok({});
      }
    });
  });
}

const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

export async function startSigningServer(planFile: string, port: number, untilMined: boolean): Promise<void> {
  const onDisk: PaymentPlan = JSON.parse(readFileSync(planFile, "utf8"));
  if (onDisk.kind !== "remit-plan" || !onDisk.source) throw new Error("not a remit plan (or made by an older remit without the invoice path)");
  if (!existsSync(onDisk.source)) throw new Error(`the invoice this plan came from is gone: ${onDisk.source}`);
  const client = pharos();
  let sentHash: Hex | undefined;

  const server = createServer(async (req, res) => {
    try {
      // Only this machine, and only a page we served: a stray site in another tab can't poke the API.
      if (req.headers.host && !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host)) return send(res, 403, { says: "local only" });
      if (req.method === "GET" && req.url === "/") return send(res, 200, PAGE);
      if (req.method === "GET" && req.url === "/plan") return send(res, 200, { summary: formatPaymentSummary(onDisk), from: onDisk.chain?.from ?? null });
      if (req.method === "POST" && req.url === "/recheck") {
        const { account, chainId } = await readBody(req);
        if (String(chainId).toLowerCase() !== PHAROS_HEX) return send(res, 200, { ok: false, says: `your wallet is on chain ${parseInt(chainId, 16)}; switch it to Pharos (1672)` });
        if (!account || !isAddress(account)) return send(res, 200, { ok: false, says: "no account connected" });
        const who = getAddress(account);
        if (onDisk.chain?.from && onDisk.chain.from.toLowerCase() !== who.toLowerCase())
          return send(res, 200, { ok: false, says: `this plan was checked for ${onDisk.chain.from}; the wallet connected is ${who}. Switch accounts, nothing was signed` });
        const fresh = await planFromFile(onDisk.source!, { from: who, client, allowExpired: onDisk.flags.some((f) => f.code === "EXPIRED_INVOICE") });
        if (!fresh.plan) return send(res, 200, { ok: false, says: fresh.flags.filter((f) => f.severity === "FATAL").map((f) => `${f.code}: ${f.message}`).join("\n") });
        if (!sameTx(fresh.plan.tx, onDisk.tx)) return send(res, 200, { ok: false, says: "the invoice now gives a different payment than the plan file you approved; make the plan again" });
        console.log(`recheck at block ${fresh.plan.chain?.block} for ${who}: all clear, handing the tx to the wallet`);
        return send(res, 200, { ok: true, tx: { ...fresh.plan.tx, from: who }, summary: formatPaymentSummary(fresh.plan) });
      }
      if (req.method === "POST" && req.url === "/sent") {
        const { hash } = await readBody(req);
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? "") || sentHash) return send(res, 400, { says: "bad or second hash" });
        sentHash = hash as Hex;
        console.log(`wallet sent ${sentHash}, waiting for the block`);
        send(res, 200, { ok: true });
        await client.waitForTransactionReceipt({ hash: sentHash, timeout: 180_000 }).catch(() => undefined);
        const verdict = await checkPaid(client, sentHash, onDisk.tx);
        console.log(`tx ${sentHash} ${verdict.ok ? "PAID: mined, succeeded, and to/value/input match the plan" : "NOT CONFIRMED as the planned payment"}`);
        for (const l of verdict.lines) console.log(`  ${l}`);
        if (untilMined) setTimeout(() => process.exit(verdict.ok ? 0 : 2), 500);
        return;
      }
      send(res, 404, { says: "nothing here" });
    } catch (e) {
      send(res, 500, { ok: false, says: (e as Error).message.split("\n")[0] });
    }
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  console.log(`remit signing page: http://127.0.0.1:${port}/  (remit holds no key; your browser wallet signs)`);
  if (untilMined) setTimeout(() => (console.log("closed after 30 min without a payment"), process.exit(3)), 30 * 60_000).unref();
}

/** For agents whose turn ends before the human reaches the wallet: run the page as its own process, return the link. */
export async function startDetached(script: string, planFile: string, port: number): Promise<string> {
  const log = logFor(planFile);
  const fd = openSync(log, "w");
  const child = spawn(process.execPath, [script, "sign", planFile, "--port", String(port), "--until-mined"], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
  child.unref();
  closeSync(fd);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch(`http://127.0.0.1:${port}/plan`)).ok) return `http://127.0.0.1:${port}/`;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null) break;
  }
  throw new Error(`the page didn't come up:\n${existsSync(log) ? readFileSync(log, "utf8").trim() : "(no log)"}`);
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>remit: pay the invoice</title>
<style>body{font:15px/1.45 system-ui,sans-serif;background:#f6f4ee;color:#1d1d1b;display:flex;justify-content:center;padding:40px 16px}
main{max-width:720px;width:100%}pre{background:#fff;border:1px solid #ddd8c8;border-radius:10px;padding:16px;white-space:pre-wrap;word-break:break-all;font:13px/1.5 ui-monospace,monospace}
button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#1e2bfa;color:#fff;cursor:pointer}button:disabled{opacity:.4}
#say{margin-top:14px;white-space:pre-wrap}.bad{color:#b3261e}.good{color:#13703a}</style></head><body><main>
<h2>Pay this invoice on Pharos</h2><pre id="summary">loading…</pre>
<button id="go">Connect wallet and pay</button><div id="say"></div>
<script>
const say=(t,c)=>{const e=document.getElementById('say');e.textContent=t;e.className=c||''};
fetch('/plan').then(r=>r.json()).then(p=>document.getElementById('summary').textContent=p.summary);
document.getElementById('go').onclick=async()=>{
  const b=document.getElementById('go');b.disabled=true;
  try{
    if(!window.ethereum){say('No browser wallet found (Rabby, OKX, MetaMask).','bad');b.disabled=false;return}
    const [account]=await ethereum.request({method:'eth_requestAccounts'});
    let chainId=await ethereum.request({method:'eth_chainId'});
    if(chainId.toLowerCase()!=='0x688'){
      try{await ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x688'}]})}
      catch(e){await ethereum.request({method:'wallet_addEthereumChain',params:[{chainId:'0x688',chainName:'Pharos',nativeCurrency:{name:'PROS',symbol:'PROS',decimals:18},rpcUrls:['https://rpc.pharos.xyz'],blockExplorerUrls:['https://www.pharosscan.xyz']}]})}
      chainId=await ethereum.request({method:'eth_chainId'});
    }
    say('Checking everything again on chain for '+account+'…');
    const v=await (await fetch('/recheck',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account,chainId})})).json();
    if(!v.ok){say('Stopped, nothing was signed:\\n'+v.says,'bad');b.disabled=false;return}
    document.getElementById('summary').textContent=v.summary;
    const t=v.tx;const req={from:t.from,to:t.to,value:t.value,data:t.data};if(t.gasLimit)req.gas=t.gasLimit;
    say('All clear. Confirm in your wallet.');
    const hash=await ethereum.request({method:'eth_sendTransaction',params:[req]});
    await fetch('/sent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hash})});
    say('Sent: '+hash+'\\nremit is waiting for the block and will compare it with the plan.','good');
  }catch(e){say('Stopped: '+(e.message||e),'bad');b.disabled=false}
};
</script></main></body></html>`;
