// Our own x402 facilitator for Pharos mainnet: verifies a buyer's signed USDC transfer authorization (EIP-3009)
// and settles it on chain, paying the gas in PROS. There is no public facilitator for Pharos, so the sellers
// run this one in the same process and also expose it over HTTP (/verify, /settle, /supported).
import { Router, json } from "express";
import { createWalletClient, custom, defineChain, publicActions, type Account } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { rpcRequest } from "harborpilot/dist/chain.js";
import { CHAIN_ID, NETWORK, RPC_URL } from "../pharos.js";

const pharos = defineChain({
  id: CHAIN_ID,
  name: "Pharos",
  nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export function facilitatorAccount(key: string): Account {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("SELLER_PRIVATE_KEY must be a 32-byte hex key");
  // The nonce is counted locally: right after a receipt a node behind the load balancer can still report the old one.
  return privateKeyToAccount(key as `0x${string}`, { nonceManager });
}

export function makeFacilitator(account: Account) {
  const client = createWalletClient({ account, chain: pharos, transport: custom({ request: rpcRequest(RPC_URL) }, { retryCount: 0 }) }).extend(publicActions);
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

  // In-process client for the sellers' resource server: no HTTP hop to ourselves.
  const local: FacilitatorClient = {
    verify: (p, r) => facilitator.verify(p, r),
    settle: (p, r) => facilitator.settle(p, r),
    getSupported: async () => facilitator.getSupported() as never,
  };

  const router = Router();
  router.use(json({ limit: "64kb" }));
  router.post("/verify", async (req, res) => {
    try {
      res.json(await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  router.post("/settle", async (req, res) => {
    try {
      res.json(await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  router.get("/supported", (_req, res) => {
    res.json(facilitator.getSupported());
  });
  return { local, router, address: account.address };
}
