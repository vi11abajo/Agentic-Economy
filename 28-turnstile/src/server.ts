// The paywalled API. Two paid routes at different prices, two free ones, and the facilitator, in one process:
//   GET /v1/pulse        0.001 USDC  how busy Pharos mainnet is right now
//   GET /v1/usdc-flows   0.005 USDC  every mainnet USDC transfer in the last 1000 blocks, biggest five linked
//   GET /health, /catalog            free
//   /facilitator/verify, /settle, /supported
// Payment is x402 "exact" on Atlantic (eip155:688689) in test USDC, through the official @x402 SDK.
import express, { type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { NETWORK, USDC, USDC_DECIMALS, USDC_DOMAIN } from "./atlantic.js";
import type { Facilitator } from "./facilitator.js";
import { pulse, usdcFlows } from "./goods.js";

export const CATALOG = [
  { path: "/v1/pulse", price: "0.001", what: "Pharos mainnet right now: head block, seconds per block, gas price, base fee, how full the last 20 blocks were" },
  { path: "/v1/usdc-flows", price: "0.005", what: "Every USDC transfer on Pharos mainnet in the last 1000 blocks: count, volume, mints, burns, the five biggest with tx links" },
] as const;

const MAX_TIMEOUT_SECONDS = 120;

export interface Goods {
  pulse: () => Promise<unknown>;
  usdcFlows: () => Promise<unknown>;
}

export function makeApp(fac: Facilitator, goods: Goods = { pulse, usdcFlows }) {
  const payTo = fac.address;
  const scheme = new ExactEvmScheme();
  // "0.005" -> 5000 units of Atlantic USDC, with the EIP-712 domain the buyer must sign against.
  scheme.registerMoneyParser(async (amount: string | number, network: string) =>
    network === NETWORK ? { amount: Math.round(Number(amount) * 10 ** USDC_DECIMALS).toString(), asset: USDC, extra: { ...USDC_DOMAIN } } : null,
  );
  const resourceServer = new x402ResourceServer(fac.local).register(NETWORK, scheme);
  const routes = Object.fromEntries(
    CATALOG.map((c) => [
      `GET ${c.path}`,
      { accepts: { scheme: "exact", price: c.price, network: NETWORK, payTo, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS }, description: c.what, mimeType: "application/json" },
    ]),
  );

  const app = express();
  app.disable("x-powered-by");
  app.use("/facilitator", fac.router);
  app.get("/health", (_req, res) => void res.json({ ok: true, network: NETWORK, asset: USDC, payTo }));
  app.get("/catalog", (_req, res) =>
    void res.json({ network: NETWORK, asset: { address: USDC, symbol: "USDC", decimals: USDC_DECIMALS }, payTo, facilitator: "/facilitator", items: CATALOG }),
  );
  app.use(paymentMiddleware(routes as never, resourceServer));

  const serve = (load: () => Promise<unknown>) => async (_req: Request, res: Response) => {
    try {
      res.json(await load());
    } catch (e) {
      // A 5xx here cancels the settlement: nobody pays for data they didn't get.
      res.status(502).json({ error: `couldn't read Pharos mainnet: ${(e as Error).message.split("\n")[0]}` });
    }
  };
  app.get("/v1/pulse", serve(goods.pulse));
  app.get("/v1/usdc-flows", serve(goods.usdcFlows));
  app.use((_req, res) => void res.status(404).json({ error: "not found", catalog: "/catalog" }));
  return { app, payTo };
}
