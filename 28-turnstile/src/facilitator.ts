// turnstile's own x402 facilitator on Atlantic: it checks a buyer's signed USDC authorization (EIP-3009) and
// settles it on chain, paying the gas in PROS. Nobody runs a public facilitator for Pharos, so the API runs this
// one in-process (no HTTP hop to itself) and also serves it over HTTP: /verify, /settle, /supported.
import { Router, json } from "express";
import { publicActions, type Account } from "viem";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { NETWORK, writer } from "./atlantic.js";

export interface Facilitator {
  local: FacilitatorClient;
  router: Router;
  address: string;
}

export function makeFacilitator(account: Account): Facilitator {
  const client = writer(account).extend(publicActions);
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    getCode: (a) => client.getCode(a),
    readContract: (a) => client.readContract({ ...a, args: a.args || [] } as never),
    verifyTypedData: (a) => client.verifyTypedData(a as never),
    writeContract: (a) => client.writeContract({ ...a, args: a.args || [] } as never),
    sendTransaction: (a) => client.sendTransaction(a as never),
    waitForTransactionReceipt: (a) => client.waitForTransactionReceipt({ ...a, pollingInterval: 500, timeout: a.timeout ?? 60_000 }),
  });
  const facilitator = new x402Facilitator();
  facilitator.register(NETWORK, new ExactEvmScheme(signer));
  const local: FacilitatorClient = {
    verify: (p, r) => facilitator.verify(p, r),
    settle: (p, r) => facilitator.settle(p, r),
    getSupported: async () => facilitator.getSupported() as never,
  };
  return { local, router: facilitatorRoutes(local), address: account.address };
}

/** The HTTP face of any facilitator client, so tests can mount a pretend one the same way. */
export function facilitatorRoutes(f: FacilitatorClient): Router {
  const router = Router();
  router.use(json({ limit: "64kb" }));
  const call = (fn: "verify" | "settle") => async (req: { body: Record<string, unknown> }, res: { json: (b: unknown) => void; status: (c: number) => { json: (b: unknown) => void } }) => {
    try {
      res.json(await f[fn](req.body.paymentPayload as never, req.body.paymentRequirements as never));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message.split("\n")[0] });
    }
  };
  router.post("/verify", call("verify"));
  router.post("/settle", call("settle"));
  router.get("/supported", async (_req, res) => void res.json(await f.getSupported()));
  return router;
}
