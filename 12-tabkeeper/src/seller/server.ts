#!/usr/bin/env node
// The two x402 sellers tabkeeper buys from, plus their facilitator, in one process on Pharos mainnet:
//   Harbor data  /x402/harbor/yields (0.002 USDC), /x402/harbor/positions/:address (0.01 USDC)
//   PROS market  /x402/pros/price (0.001 USDC)
//   facilitator  /x402/facilitator/verify, /settle, /supported
//   free         /x402/health, /x402/catalog
// Env: SELLER_PRIVATE_KEY (receives the USDC and pays the settlement gas), PORT (4021), DATA_DIR (./seller-data).
import { join } from "node:path";
import express, { type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { makeClient } from "harborpilot/dist/chain.js";
import { NETWORK, RPC_URL, USDC, USDC_DECIMALS, USDC_DOMAIN } from "../pharos.js";
import { harborData, prosData } from "./data.js";
import { facilitatorAccount, makeFacilitator } from "./facilitator.js";
import { replayStore } from "./replay.js";

export const PREFIX = "/x402";

/** What is for sale. The catalog route lists it for free; the prices are what the 402s ask for. */
export const CATALOG = [
  { seller: "Harbor data", method: "GET", path: "/harbor/yields", query: "amount=<USDC> (default 100)", price: "0.002", description: "All 16 Pharos Harbor assets read live: realized 7d/30d yield, TVL, whether a deposit of that size passes right now and why not, how money comes back, and the best pick" },
  { seller: "Harbor data", method: "GET", path: "/harbor/positions/:address", query: "", price: "0.01", description: "One wallet's holdings in every Harbor venue, open requests, and its Morpho USDC/WPROS loan with LTV and liquidation price" },
  { seller: "PROS market", method: "GET", path: "/pros/price", query: "", price: "0.001", description: "PROS on Faroswap V3: mid price and reserves of every WPROS/USDC pool, plus the Chainlink PROS/USD feed and its age" },
] as const;

const MAX_TIMEOUT_SECONDS = 120;

export function makeApp(o: { key: string; dataDir: string }) {
  const client = makeClient(RPC_URL);
  const fac = makeFacilitator(facilitatorAccount(o.key));
  const payTo = fac.address;

  const scheme = new ExactEvmScheme();
  scheme.registerMoneyParser(async (amount: string | number, network: string) =>
    network === NETWORK ? { amount: Math.round(Number(amount) * 10 ** USDC_DECIMALS).toString(), asset: USDC, extra: { ...USDC_DOMAIN } } : null,
  );
  const resourceServer = new x402ResourceServer(fac.local).register(NETWORK, scheme);
  const routes = Object.fromEntries(
    CATALOG.map((c) => [
      `${c.method} ${PREFIX}${c.path}`,
      { accepts: { scheme: "exact", price: c.price, network: NETWORK, payTo, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS }, description: `${c.seller}: ${c.description}`, mimeType: "application/json" },
    ]),
  );

  const harbor = harborData(client);
  const pros = prosData(client);
  const replay = replayStore(join(o.dataDir, "paid-responses.json"));

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(`${PREFIX}/facilitator`, fac.router);
  app.get(`${PREFIX}/health`, (_req, res) => void res.json({ ok: true, network: NETWORK, asset: USDC, payTo }));
  app.get(`${PREFIX}/catalog`, (_req, res) =>
    void res.json({ network: NETWORK, asset: { address: USDC, symbol: "USDC", decimals: USDC_DECIMALS }, payTo, facilitator: `${PREFIX}/facilitator`, items: CATALOG.map((c) => ({ ...c, path: `${PREFIX}${c.path}` })) }),
  );
  app.use(replay.middleware);
  app.use(paymentMiddleware(routes as never, resourceServer));

  const serve = (load: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      res.json(await load(req));
    } catch (e) {
      // A 5xx here cancels the settlement: the buyer is not charged for data it didn't get.
      res.status(502).json({ error: `could not read Pharos: ${(e as Error).message.split("\n")[0]}` });
    }
  };
  app.get(`${PREFIX}/harbor/yields`, serve((req) => harbor.yields(typeof req.query.amount === "string" ? req.query.amount : undefined)));
  app.get(`${PREFIX}/harbor/positions/:address`, serve((req) => harbor.positions(String(req.params.address))));
  app.get(`${PREFIX}/pros/price`, serve(() => pros.price()));
  app.use((_req, res) => void res.status(404).json({ error: "not found", catalog: `${PREFIX}/catalog` }));
  return { app, payTo };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("seller/server.js")) {
  const key = process.env.SELLER_PRIVATE_KEY;
  if (!key) {
    console.error("Set SELLER_PRIVATE_KEY (the seller's key: it receives the USDC and pays the settlement gas)");
    process.exit(2);
  }
  const port = Number(process.env.PORT || 4021);
  const { app, payTo } = makeApp({ key, dataDir: process.env.DATA_DIR || "seller-data" });
  app.listen(port, () => console.log(`x402 sellers on :${port}${PREFIX}, ${NETWORK}, paying to ${payTo}`));
}
