// One door to Pharos for everything Prosperion reads. Plain RPC, not the Chain MCP: the MCP is the agent's
// second opinion, and it is rate limited to 120 calls a minute, which a block-by-block watcher would eat alone.
import { createPublicClient, custom, defineChain, type PublicClient } from "viem";

export const PHAROS_RPC = process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";

export const pharos = defineChain({
  id: 1672,
  name: "Pharos Mainnet",
  nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
  rpcUrls: { default: { http: [PHAROS_RPC] } },
  blockExplorers: { default: { name: "Pharosscan", url: EXPLORER } },
});

// The public node says "cu limit exceeded; Request too fast per second" (code -32011) when pushed, and viem does
// not retry that one. So requests go through our own queue: at most a few in flight, and a backoff on that answer.
// Learned the hard way in harborpilot (task 11).
const LIMITED = /too fast|cu limit|rate limit|too many|try again|busy|header not found|unknown block|cannot be greater/i;

export function rpcRequest(url: string, maxInFlight = 4) {
  let inFlight = 0;
  const queue: (() => void)[] = [];
  const acquire = () =>
    inFlight < maxInFlight ? (inFlight++, Promise.resolve()) : new Promise<void>((r) => queue.push(() => (inFlight++, r())));
  const release = () => { inFlight--; queue.shift()?.(); };
  let id = 0;
  return async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      await acquire();
      let j: { result?: unknown; error?: { code: number; message: string; data?: unknown } } | null = null;
      let netErr: string | undefined;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        try { j = JSON.parse(text); } catch { netErr = `HTTP ${res.status}: ${text.slice(0, 120)}`; }
      } catch (e) {
        netErr = (e as Error).message;
      } finally {
        release();
      }
      const retry = netErr !== undefined || (j?.error && LIMITED.test(j.error.message ?? ""));
      if (!retry) {
        if (j?.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
        return j?.result;
      }
      if (attempt >= 7) throw new Error(`${method}: the RPC kept failing (${netErr ?? j?.error?.message})`);
      await new Promise((r) => setTimeout(r, 400 * 2 ** Math.min(attempt, 4) + Math.random() * 300));
    }
  };
}

export const client: PublicClient = createPublicClient({
  chain: pharos,
  transport: custom({ request: rpcRequest(PHAROS_RPC) }, { retryCount: 0 }),
});

export async function blockNow(): Promise<bigint> {
  return client.getBlockNumber({ cacheTime: 0 });
}
